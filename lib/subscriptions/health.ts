import type { DatabaseSync } from "node:sqlite";
import type { SubscriptionQuota } from "@pluhub/contracts/subscription";
import type { SubscriptionKind } from "../ai/subscription-auth.js";
import { transaction } from "../storage/sqlite.js";

export const healthMigration = `
  ALTER TABLE accounts ADD COLUMN health_revision INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE account_cooldowns(account_id TEXT NOT NULL,model TEXT NOT NULL,until INTEGER NOT NULL,
    PRIMARY KEY(account_id,model));
`;
function scope(
  kind: SubscriptionKind,
  q: SubscriptionQuota,
): string | undefined {
  if (kind === "grok" && ["requests", "tokens"].includes(q.window)) return "";
  if (kind === "antigravity" && q.window.startsWith("model:"))
    return q.window.slice(6);
  if (kind === "codex" && ["primary", "secondary"].includes(q.window))
    return "";
  if (kind === "claude-subscription") {
    if (["five_hour", "seven_day"].includes(q.window)) return "";
    const family = /^seven_day_(sonnet|opus|haiku)$/.exec(q.window)?.[1];
    if (family) return "family:" + family;
  }
}
const canonical = (model: string) => model.replace(/^models\//, "");
const matches = (rule: string, model: string) =>
  !rule ||
  canonical(rule) === canonical(model) ||
  (rule.startsWith("family:") && model.toLowerCase().includes(rule.slice(7)));
export function validQuota(values: unknown): values is SubscriptionQuota[] {
  return (
    Array.isArray(values) &&
    values.length <= 512 &&
    values.every(
      (q) =>
        q &&
        typeof q.window === "string" &&
        q.window.length <= 512 &&
        Number.isFinite(q.usedPercent) &&
        q.usedPercent >= 0 &&
        q.usedPercent <= 100 &&
        (q.resetAt === undefined ||
          (Number.isFinite(q.resetAt) &&
            q.resetAt >= 0 &&
            q.resetAt <= Date.now() + 366 * 86400000)),
    )
  );
}
export function createSubscriptionHealth(
  db: DatabaseSync,
  kind: SubscriptionKind,
  notify: (id: string) => void,
) {
  const cooldowns = (id: string) =>
    db
      .prepare("SELECT model,until FROM account_cooldowns WHERE account_id=?")
      .all(id) as { model: string; until: number }[];
  const blocked = (id: string, model = "") =>
    cooldowns(id).some((c) => matches(c.model, model));
  function exhaust(id: string, model: string, resetAt?: number) {
    model = canonical(model);
    const until =
      resetAt && resetAt > Date.now() ? resetAt : Date.now() + 60000;
    db.prepare(
      `INSERT INTO account_cooldowns(account_id,model,until) VALUES(?,?,?)
      ON CONFLICT(account_id,model) DO UPDATE SET until=MAX(until,excluded.until)`,
    ).run(id, model, until);
  }
  function quota(
    id: string,
    values: SubscriptionQuota[],
    authoritative: boolean,
  ) {
    const known = values.flatMap((q) => {
      const model = scope(kind, q);
      return model === undefined ? [] : [{ q, model }];
    });
    if (authoritative)
      for (const current of cooldowns(id))
        if (known.some((item) => matches(item.model, current.model)))
          db.prepare(
            "DELETE FROM account_cooldowns WHERE account_id=? AND model=?",
          ).run(id, current.model);
    for (const { q, model } of known)
      if (q.usedPercent >= 100) exhaust(id, model, q.resetAt);
  }
  function report(
    r: any,
    input: {
      status: number;
      retryAfter?: string | null;
      quota?: SubscriptionQuota[];
      quotaExhausted?: boolean;
      resetAt?: number;
    },
    model = "",
  ) {
    const values = validQuota(input.quota) ? input.quota! : [];
    if (input.status < 400 && !values.length) return;
    if (
      input.status >= 400 &&
      input.status < 500 &&
      ![401, 403, 429].includes(input.status)
    )
      return;
    if (values.length) {
      const merged = new Map<string, SubscriptionQuota>(
        JSON.parse(r.quota_json).map((q: SubscriptionQuota) => [q.window, q]),
      );
      for (const q of values)
        merged.set(q.window, { ...q, updatedAt: Date.now() });
      db.prepare(
        "UPDATE accounts SET quota_json=?,quota_updated_at=? WHERE id=?",
      ).run(JSON.stringify([...merged.values()]), Date.now(), r.id);
      // Passive headers may be stale across concurrent requests; only control-plane
      // snapshots may clear exhaustion. New exhausted windows are always retained.
      quota(r.id, values, false);
    }
    let status = r.status,
      code = r.error_code,
      until = r.cooldown_until;
    if (input.quotaExhausted) {
      exhaust(r.id, model, input.resetAt);
      code = "subscription_quota_exhausted";
    } else if (input.status === 401) {
      status = "reauthorize";
      code = "subscription_reauthorize";
    } else if (input.status === 403) {
      status = "forbidden";
      code = "subscription_forbidden";
    } else if (input.status === 429 || input.status >= 500) {
      const retry = input.retryAfter?.trim() ?? "";
      const seconds = /^\d+(\.\d+)?$/.test(retry)
        ? Number(retry)
        : (Date.parse(retry) - Date.now()) / 1000;
      until = Math.max(
        until,
        Date.now() +
          Math.min(
            86400,
            Math.max(
              1,
              Number.isFinite(seconds)
                ? seconds
                : input.status === 429
                  ? 60
                  : 10,
            ),
          ) *
            1000,
      );
      code =
        input.status === 429
          ? "subscription_rate_limited"
          : "subscription_upstream_error";
    }
    db.prepare(
      `UPDATE accounts SET status=?,error_code=?,cooldown_until=?,last_status=?,
      health_revision=health_revision+1 WHERE id=? AND version=?`,
    ).run(status, code, until, input.status, r.id, r.version);
    notify(r.id);
  }
  function recovered(
    id: string,
    values: SubscriptionQuota[],
    revision: number,
  ) {
    const r = db.prepare("SELECT * FROM accounts WHERE id=?").get(id) as any;
    if (
      !r ||
      !r.enabled ||
      r.health_revision !== revision ||
      r.status === "reauthorize"
    )
      return;
    quota(id, values, true);
    db.prepare(
      `UPDATE accounts SET status='ready',error_code=CASE WHEN cooldown_until<=? THEN NULL ELSE error_code END,
      health_revision=health_revision+1 WHERE id=?`,
    ).run(Date.now(), id);
    notify(id);
  }
  function remove(id: string) {
    db.prepare("DELETE FROM account_cooldowns WHERE account_id=?").run(id);
    notify(id);
  }
  // Providers without a quota endpoint retry only after their advertised reset.
  function expire(id: string) {
    const result = db
      .prepare("DELETE FROM account_cooldowns WHERE account_id=? AND until<=?")
      .run(id, Date.now());
    if (result.changes) notify(id);
  }
  return {
    blocked,
    cooldowns,
    report: (...args: Parameters<typeof report>) =>
      transaction(db, () => report(...args)),
    recovered,
    expire,
    remove,
  };
}
