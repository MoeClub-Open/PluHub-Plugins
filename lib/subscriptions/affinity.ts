import { HostError } from "@pluhub/sdk";
import type { DatabaseSync } from "node:sqlite";

export const affinityMigration = `
  CREATE TABLE session_affinity(session_key TEXT PRIMARY KEY,account_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
  CREATE INDEX session_affinity_expiry ON session_affinity(expires_at);
  CREATE INDEX session_affinity_account ON session_affinity(account_id);
`;
interface Account {
  id: string;
  enabled: number;
  status: string;
  cooldown_until: number;
  max_concurrency: number;
  last_used: number;
  version: number;
}

/** Bind before credential resolution so concurrent first turns cannot split. */
export function createSessionAffinity(
  db: DatabaseSync,
  active: Map<string, number>,
  stopped: AbortSignal,
) {
  const ttl = 60 * 60 * 1000;
  const waiters = new Map<string, Set<() => void>>();
  let nextSweep = 0;
  function notify(id: string) {
    for (const wake of [...(waiters.get(id) ?? [])]) wake();
  }
  function wait(id: string, signal: AbortSignal) {
    signal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      const queue = waiters.get(id) ?? new Set<() => void>();
      const cleanup = () => {
        signal.removeEventListener("abort", abort);
        queue.delete(wake);
        if (!queue.size) waiters.delete(id);
      };
      const wake = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      queue.add(wake);
      waiters.set(id, queue);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  async function acquire(
    load: () => Account[],
    sessionKey: string | undefined,
    signal: AbortSignal,
  ) {
    let waiting: AbortSignal | undefined;
    for (;;) {
      signal.throwIfAborted();
      stopped.throwIfAborted();
      const now = Date.now();
      if (now >= nextSweep) {
        db.prepare("DELETE FROM session_affinity WHERE expires_at<=?").run(now);
        nextSweep = now + 60000;
      }
      const ready = load().filter(
        (r) => r.enabled && r.status === "ready" && r.cooldown_until <= now,
      );
      const binding = sessionKey
        ? (db
            .prepare(
              "SELECT account_id FROM session_affinity WHERE session_key=? AND expires_at>?",
            )
            .get(sessionKey, now) as { account_id: string } | undefined)
        : undefined;
      const bound = ready.find((r) => r.id === binding?.account_id);
      if (bound && (active.get(bound.id) ?? 0) >= bound.max_concurrency) {
        waiting ??= AbortSignal.any([
          signal,
          stopped,
          AbortSignal.timeout(15000),
        ]);
        try {
          await wait(bound.id, waiting);
        } catch {
          signal.throwIfAborted();
          stopped.throwIfAborted();
          throw new HostError(
            "subscription_busy",
            "会话绑定的订阅账号繁忙，请稍后重试",
            429,
          );
        }
        continue;
      }
      const selected =
        bound ??
        ready
          .filter((r) => (active.get(r.id) ?? 0) < r.max_concurrency)
          .sort(
            (a, b) =>
              (active.get(a.id) ?? 0) / a.max_concurrency -
                (active.get(b.id) ?? 0) / b.max_concurrency ||
              a.last_used - b.last_used,
          )[0];
      if (!selected)
        throw new HostError(
          "subscription_unavailable",
          "暂无可用订阅账号",
          503,
        );
      if (sessionKey)
        db.prepare(
          `INSERT INTO session_affinity(session_key,account_id,expires_at) VALUES(?,?,?)
          ON CONFLICT(session_key) DO UPDATE SET account_id=excluded.account_id,expires_at=excluded.expires_at`,
        ).run(sessionKey, selected.id, now + ttl);
      db.prepare("UPDATE accounts SET last_used=? WHERE id=?").run(
        now,
        selected.id,
      );
      active.set(selected.id, (active.get(selected.id) ?? 0) + 1);
      return selected;
    }
  }
  function forget(sessionKey: string | undefined, accountId: string) {
    if (sessionKey)
      db.prepare(
        "DELETE FROM session_affinity WHERE session_key=? AND account_id=?",
      ).run(sessionKey, accountId);
  }
  function remove(accountId: string) {
    db.prepare("DELETE FROM session_affinity WHERE account_id=?").run(
      accountId,
    );
    notify(accountId);
  }
  return { acquire, notify, forget, remove };
}
