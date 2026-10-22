import { waitFor as cancellable } from "../ai/cancellation.js";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import {
  HostError,
  json,
  readObject,
  requiredString,
  type RequestContext,
  type Host,
} from "@pluhub/sdk";
import type {
  SubscriptionAccountCommand,
  SubscriptionCredential,
  SubscriptionLease,
} from "@pluhub/contracts/subscription";
import { openDatabase, transaction } from "../storage/sqlite.js";
import { affinityMigration, createSessionAffinity } from "./affinity.js";
import { healthMigration, createSubscriptionHealth } from "./health.js";
import { startSubscriptionMaintenance } from "./maintenance.js";
import {
  normalizeSubscriptionToken,
  subscriptionKind,
  type SubscriptionToken,
  type SubscriptionKind,
} from "../ai/subscription-auth.js";
import { discoverAntigravityProject } from "../ai/antigravity-control.js";
import { oauthConfig, tokenRequest } from "./oauth.js";
import { createSubscriptionOAuth } from "./oauth-flow.js";
import { subscriptionOverview, subscriptionNames } from "./overview.js";

const fail = (code: string, message: string, status = 400): never => {
  throw new HostError(code, message, status);
};
const concurrency = (n: unknown) => {
  if (!Number.isSafeInteger(n) || Number(n) < 1 || Number(n) > 100)
    fail("invalid_concurrency", "最大并发应为 1 至 100");
  return Number(n);
};
export function setupSubscriptionAccounts(host: Host, kind: SubscriptionKind) {
  const initialMasterKeyRef = host.config().masterKeyRef;
  const keyFile = join(host.dataDir, "vault.key");
  let master: Buffer;
  if (host.config().masterKeyRef)
    master = Buffer.from(
      host.secret(String(host.config().masterKeyRef)),
      "base64",
    );
  else {
    try {
      master = readFileSync(keyFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      master = randomBytes(32);
      writeFileSync(keyFile, master, { flag: "wx", mode: 0o600 });
    }
    chmodSync(keyFile, 0o600);
  }
  if (master.length !== 32)
    fail("invalid_config", "Vault key must be 32 bytes");
  const db = openDatabase(join(host.dataDir, "accounts.sqlite"), [
    `CREATE TABLE accounts(id TEXT PRIMARY KEY,provider TEXT NOT NULL,name TEXT NOT NULL,cipher TEXT NOT NULL,
       enabled INTEGER NOT NULL DEFAULT 1,max_concurrency INTEGER NOT NULL DEFAULT 2,status TEXT NOT NULL DEFAULT 'ready',
       cooldown_until INTEGER NOT NULL DEFAULT 0,error_code TEXT,last_status INTEGER,last_used INTEGER NOT NULL DEFAULT 0,
       version INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);`,
    "ALTER TABLE accounts ADD COLUMN quota_json TEXT NOT NULL DEFAULT '[]'; ALTER TABLE accounts ADD COLUMN quota_updated_at INTEGER;",
    "ALTER TABLE accounts ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''; CREATE INDEX accounts_owner ON accounts(owner_id);",
    affinityMigration,
    healthMigration,
  ]);
  const stop = new AbortController();
  const refreshing = new Map<string, Promise<SubscriptionCredential>>();
  const checking = new Map<string, Promise<unknown>>();
  const leases = new Map<
    string,
    { id: string; version: number; model?: string }
  >();
  const active = new Map<string, number>();
  const affinity = createSessionAffinity(db, active, stop.signal);
  const health = createSubscriptionHealth(db, kind, affinity.notify);
  const row = (id: string): any =>
    db.prepare("SELECT * FROM accounts WHERE id=?").get(id) ??
    fail("subscription_not_found", "订阅账号不存在", 404);
  const ownedRow = (id: string, ownerId = ""): any => {
    const r = row(requiredString(id, "id"));
    if (r.owner_id !== ownerId)
      fail("subscription_not_found", "订阅账号不存在", 404);
    return r;
  };
  const poolRows = (ids: string[], ownerId = "") =>
    ids.flatMap((id) => {
      const r = db.prepare("SELECT * FROM accounts WHERE id=?").get(id) as any;
      if (!r) return [];
      if (r.owner_id !== ownerId)
        fail("subscription_not_found", "订阅账号不存在", 404);
      if (r.provider !== kind)
        fail("subscription_provider", "订阅账号与提供商不匹配");
      return [r];
    });
  const aad = (id: string, provider: string, ownerId = "") =>
    Buffer.from(
      JSON.stringify(ownerId ? [id, provider, ownerId] : [id, provider]),
    );
  function encrypt(
    id: string,
    provider: string,
    value: SubscriptionToken,
    ownerId = "",
  ) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", master, iv);
    cipher.setAAD(aad(id, provider, ownerId));
    return Buffer.concat([
      iv,
      cipher.update(JSON.stringify(value)),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64");
  }
  function decrypt(r: any): SubscriptionToken {
    const data = Buffer.from(r.cipher, "base64"),
      cipher = createDecipheriv("aes-256-gcm", master, data.subarray(0, 12));
    cipher.setAAD(aad(r.id, r.provider, r.owner_id));
    cipher.setAuthTag(data.subarray(-16));
    return JSON.parse(
      Buffer.concat([
        cipher.update(data.subarray(12, -16)),
        cipher.final(),
      ]).toString(),
    );
  }
  function metadata(r: any) {
    const value = decrypt(r);
    return {
      id: r.id,
      provider: r.provider,
      name: r.name,
      email: value.email,
      plan: value.plan_type,
      credits: value.credits,
      enabled: !!r.enabled,
      maxConcurrency: r.max_concurrency,
      status: !r.enabled
        ? "disabled"
        : r.status !== "ready"
          ? r.status
          : r.cooldown_until > Date.now() || health.blocked(r.id)
            ? "cooldown"
            : value.expires_at !== undefined &&
                value.expires_at <= Date.now() &&
                !value.refresh_token
              ? "reauthorize"
              : "ready",
      cooldownUntil: Math.max(
        r.cooldown_until,
        ...health
          .cooldowns(r.id)
          .filter((c) => !c.model)
          .map((c) => c.until),
      ),
      modelCooldowns: health.cooldowns(r.id).filter((c) => c.model),
      errorCode: r.error_code,
      lastStatus: r.last_status,
      active: active.get(r.id) ?? 0,
      expiresAt: value.expires_at,
      refreshable: !!value.refresh_token,
      accountId: value.account_id,
      projectId: value.project_id,
      quota: JSON.parse(r.quota_json),
      quotaUpdatedAt: r.quota_updated_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  function credential(r: any): SubscriptionCredential {
    const value = decrypt(r);
    if (!r.enabled) fail("subscription_disabled", "订阅账号已停用", 503);
    if (!value.access_token)
      fail("subscription_reauthorize", "订阅授权已失效，请重新授权", 503);
    return {
      secret: value.access_token!,
      accountId: value.account_id,
      projectId: value.project_id,
      version: r.version,
    };
  }
  async function save(input: any, ownerId = "", signal?: AbortSignal) {
    const provider = subscriptionKind(input.provider ?? kind);
    if (provider !== kind)
      fail("subscription_provider", "订阅账号与提供商不匹配");
    const max = concurrency(input.maxConcurrency ?? 2),
      id = input.id ? requiredString(input.id, "id") : randomUUID();
    const previous = input.id ? ownedRow(id, ownerId) : undefined;
    if (
      !previous &&
      ownerId &&
      Number(
        (
          db
            .prepare("SELECT COUNT(*) AS n FROM accounts WHERE owner_id=?")
            .get(ownerId) as any
        ).n,
      ) >= 64
    )
      fail("subscription_limit", "最多可保存 64 个订阅账号");
    if (previous && previous.provider !== provider)
      fail("subscription_provider", "无法更改授权提供商");
    let token = normalizeSubscriptionToken(input.authorization);
    if (previous) token = { ...decrypt(previous), ...token };
    if (provider === "antigravity" && token.access_token && !token.project_id) {
      const discovery = AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(15000),
      ]);
      try {
        token.project_id = await discoverAntigravityProject(
          host,
          token.access_token!,
          discovery,
        );
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
    const requestedName = input.name
      ? requiredString(input.name, "name", 254).trim()
      : "";
    const candidateName = requestedName || previous?.name;
    const name =
      !candidateName ||
      [provider, subscriptionNames[provider]].includes(candidateName)
        ? token.email || candidateName || subscriptionNames[provider]
        : candidateName;
    db.prepare(
      `INSERT INTO accounts(id,provider,name,cipher,max_concurrency,created_at,updated_at,owner_id) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,cipher=excluded.cipher,max_concurrency=excluded.max_concurrency,
        status='ready',cooldown_until=0,error_code=NULL,last_status=NULL,quota_json='[]',quota_updated_at=NULL,version=accounts.version+1,updated_at=excluded.updated_at`,
    ).run(
      id,
      provider,
      name,
      encrypt(id, provider, token, ownerId),
      max,
      Date.now(),
      Date.now(),
      ownerId,
    );
    health.remove(id);
    return metadata(row(id));
  }
  async function resolve(
    id: string,
    forceVersion?: number,
    ahead = 60000,
  ): Promise<SubscriptionCredential> {
    const r = row(id),
      value = decrypt(r);
    if (!r.enabled) fail("subscription_disabled", "订阅账号已停用", 503);
    if (forceVersion !== undefined && forceVersion !== r.version)
      return credential(r);
    const expired =
      !value.access_token ||
      (value.expires_at !== undefined &&
        value.expires_at <= Date.now() + ahead);
    if (!expired && forceVersion === undefined) return credential(r);
    const existing = refreshing.get(id);
    if (existing) return existing;
    if (!value.refresh_token) {
      db.prepare(
        "UPDATE accounts SET status='reauthorize',error_code='subscription_reauthorize' WHERE id=? AND version=?",
      ).run(id, r.version);
      return fail(
        "subscription_reauthorize",
        "订阅授权已失效，请重新授权",
        503,
      );
    }
    const task = (async () => {
      try {
        const response = await tokenRequest(
          host,
          r.provider,
          {
            grant_type: "refresh_token",
            refresh_token: value.refresh_token!,
          },
          AbortSignal.any([stop.signal, AbortSignal.timeout(30000)]),
        );
        const next = normalizeSubscriptionToken(response);
        if (
          !next.access_token ||
          !next.expires_at ||
          next.expires_at <= Date.now()
        )
          fail("oauth_response", "刷新响应缺少有效令牌或到期时间", 502);
        const latest = row(id);
        if (latest.version !== r.version) return credential(latest);
        const merged = {
          ...decrypt(latest),
          ...next,
          refresh_token: next.refresh_token ?? value.refresh_token,
          account_id: next.account_id ?? value.account_id,
          project_id: next.project_id ?? value.project_id,
        };
        db.prepare(
          `UPDATE accounts SET cipher=?,version=version+1,
            status=CASE WHEN status='reauthorize' THEN 'ready' ELSE status END,
            error_code=CASE WHEN error_code IN ('oauth_refresh_failed','subscription_reauthorize') THEN NULL ELSE error_code END,
            updated_at=? WHERE id=? AND version=?`,
        ).run(
          encrypt(id, r.provider, merged, r.owner_id),
          Date.now(),
          id,
          r.version,
        );
        return credential(row(id));
      } catch (error) {
        if (stop.signal.aborted) throw error;
        // A re-import or project update wins over an in-flight refresh.
        const current = row(id);
        if (current.version !== r.version) return credential(current);
        const code =
          error instanceof HostError ? error.code : "oauth_refresh_failed";
        if (
          code !== "subscription_reauthorize" &&
          forceVersion === undefined &&
          value.access_token &&
          value.expires_at !== undefined &&
          value.expires_at > Date.now() + 60000
        )
          throw error instanceof HostError
            ? error
            : new HostError("oauth_refresh_failed", "授权服务暂时不可用", 502);
        db.prepare(
          "UPDATE accounts SET status=?,error_code=?,cooldown_until=MAX(cooldown_until,?),health_revision=health_revision+1 WHERE id=? AND version=?",
        ).run(
          code === "subscription_reauthorize" ? "reauthorize" : current.status,
          code,
          Date.now() + 30000,
          id,
          r.version,
        );
        throw error instanceof HostError
          ? error
          : new HostError("oauth_refresh_failed", "授权服务暂时不可用", 502);
      }
    })();
    refreshing.set(id, task);
    try {
      return await task;
    } catch (error) {
      if (
        !stop.signal.aborted &&
        forceVersion === undefined &&
        (!(error instanceof HostError) ||
          error.code !== "subscription_reauthorize") &&
        value.access_token &&
        value.expires_at !== undefined &&
        value.expires_at > Date.now() + 60000
      )
        return credential(row(id));
      throw error;
    } finally {
      if (refreshing.get(id) === task) refreshing.delete(id);
    }
  }
  function release(leaseId: string) {
    const lease = leases.get(leaseId);
    if (lease) {
      leases.delete(leaseId);
      const remaining = Math.max(0, (active.get(lease.id) ?? 1) - 1);
      if (remaining) active.set(lease.id, remaining);
      else active.delete(lease.id);
      affinity.notify(lease.id);
    }
  }
  async function queryOverview(id: string) {
    const pending = checking.get(id);
    if (pending) return pending;
    const task = (async () => {
      let token = await resolve(id);
      let current = row(id);
      const read = () =>
        subscriptionOverview(
          host,
          kind,
          decrypt(current),
          AbortSignal.any([stop.signal, AbortSignal.timeout(20000)]),
        );
      let overview: Awaited<ReturnType<typeof subscriptionOverview>>;
      try {
        try {
          overview = await read();
        } catch (error) {
          if (
            !(error instanceof HostError) ||
            error.code !== "subscription_reauthorize" ||
            !decrypt(current).refresh_token
          )
            throw error;
          token = await resolve(id, token.version);
          current = row(id);
          overview = await read();
        }
      } catch (error) {
        if (
          error instanceof HostError &&
          error.code === "subscription_reauthorize"
        ) {
          db.prepare(
            `UPDATE accounts SET status='reauthorize',error_code='subscription_reauthorize',
            health_revision=health_revision+1 WHERE id=? AND version=?`,
          ).run(id, token.version);
          affinity.notify(id);
        }
        throw error;
      }
      const value = decrypt(current);
      const latest = row(id);
      if (
        latest.version !== token.version ||
        !latest.enabled ||
        latest.health_revision !== current.health_revision
      )
        return metadata(latest);
      const name =
        overview.email && [kind, subscriptionNames[kind]].includes(latest.name)
          ? overview.email
          : latest.name;
      const updated = {
        ...decrypt(latest),
        email: overview.email ?? value.email,
        plan_type: overview.plan ?? value.plan_type,
        credits: overview.credits,
        project_id: overview.projectId ?? value.project_id,
      };
      // Quota metadata does not rotate credentials; refresh merges the latest encrypted metadata.
      transaction(db, () => {
        db.prepare(
          "UPDATE accounts SET name=?,quota_json=?,quota_updated_at=?,cipher=? WHERE id=? AND version=?",
        ).run(
          name,
          JSON.stringify(overview.quota),
          Date.now(),
          encrypt(id, kind, updated, latest.owner_id),
          id,
          token.version,
        );
        health.recovered(id, overview.quota, current.health_revision);
      });
      return metadata(row(id));
    })();
    checking.set(id, task);
    try {
      return await task;
    } finally {
      if (checking.get(id) === task) checking.delete(id);
    }
  }
  host.provide(
    `ai.subscription.${kind}@1`,
    async (input: SubscriptionAccountCommand, signal) => {
      signal.throwIfAborted();
      if ("provider" in input && input.provider && input.provider !== kind)
        fail("subscription_provider", "订阅账号与提供商不匹配");
      if (input.action === "inspect") {
        const r = ownedRow(input.id, input.ownerId ?? "");
        if (input.provider && r.provider !== input.provider)
          fail("subscription_provider", "订阅账号与提供商不匹配");
        return metadata(r);
      }
      if (input.action === "acquire" || input.action === "availability") {
        if (
          !Array.isArray(input.ids) ||
          !input.ids.length ||
          input.ids.length > 100 ||
          new Set(input.ids).size !== input.ids.length ||
          input.ids.some((id) => typeof id !== "string" || id.length > 256)
        )
          fail("subscription_binding", "请选择订阅账号，且不可重复");
        if (input.action === "availability")
          return {
            available: poolRows(input.ids, input.ownerId).some(
              (r) =>
                r.enabled &&
                r.status === "ready" &&
                r.cooldown_until <= Date.now() &&
                !health.blocked(r.id, input.model),
            ),
          };
        const sessionKey = input.sessionId
          ? JSON.stringify([
              input.ownerId ?? "",
              requiredString(input.sessionId, "sessionId", 256),
            ])
          : undefined;
        if (
          input.excludeIds !== undefined &&
          (!Array.isArray(input.excludeIds) ||
            input.excludeIds.some((id) => typeof id !== "string"))
        )
          fail("subscription_binding", "无效的账号排除列表");
        const excluded = new Set(input.excludeIds ?? []);
        let failure: unknown;
        for (
          let attempt = 0;
          attempt < Math.min(3, input.ids.length);
          attempt++
        ) {
          let selected;
          try {
            selected = await affinity.acquire(
              () =>
                poolRows(input.ids, input.ownerId).filter(
                  (r) =>
                    !excluded.has(r.id) && !health.blocked(r.id, input.model),
                ),
              sessionKey,
              signal,
            );
          } catch (error) {
            if (
              error instanceof HostError &&
              error.code === "subscription_unavailable" &&
              failure
            )
              throw failure;
            throw error;
          }
          const leaseId = randomUUID();
          leases.set(leaseId, {
            id: selected.id,
            version: selected.version,
            model: input.model,
          });
          try {
            const result = await cancellable(resolve(selected.id), signal);
            signal.throwIfAborted();
            leases.get(leaseId)!.version = result.version;
            return {
              leaseId,
              accountId: selected.id,
              credential: result,
            } satisfies SubscriptionLease;
          } catch (error) {
            release(leaseId);
            signal.throwIfAborted();
            stop.signal.throwIfAborted();
            affinity.forget(sessionKey, selected.id);
            if (
              !(error instanceof HostError) ||
              ![
                "subscription_reauthorize",
                "oauth_refresh_failed",
                "oauth_response",
                "subscription_disabled",
              ].includes(error.code)
            )
              throw error;
            excluded.add(selected.id);
            failure = error;
          }
        }
        throw failure;
      }
      if (input.action === "release") {
        release(input.leaseId);
        return;
      }
      const lease =
        leases.get(input.leaseId) ??
        fail("subscription_lease", "订阅账号占用已失效", 409);
      if (input.action === "refresh") {
        const result = await cancellable(
          resolve(lease.id, input.version),
          signal,
        );
        signal.throwIfAborted();
        lease.version = result.version;
        return result;
      }
      if (input.action === "report") {
        const r = db
          .prepare("SELECT * FROM accounts WHERE id=?")
          .get(lease.id) as any;
        if (!r || r.version !== input.version) return;
        health.report(r, input, lease.model);
        return;
      }
      fail("subscription_action", "Unknown subscription account action");
    },
  );
  const session = (ctx: RequestContext) => {
    if (!ctx.principal?.session)
      fail("session_required", "请使用控制台会话", 403);
    return ctx.principal!;
  };
  const oauth = createSubscriptionOAuth(host, save, kind);
  host.api({
    method: "GET",
    path: "/oauth/callback",
    access: "public",
    handle: (request) => oauth.receive(request),
  });
  for (const personal of [false, true]) {
    const owner = (ctx: RequestContext) => (personal ? ctx.principal!.id : "");
    const api = (
      method: string,
      path: string,
      handle: (r: Request, c: RequestContext) => Response | Promise<Response>,
    ) =>
      host.api({
        method,
        path: (personal ? "/personal" : "") + path,
        access: personal ? "authenticated" : "admin",
        handle: (r, c) => {
          session(c);
          return handle(r, c);
        },
      });
    api("GET", "/accounts", (_r, ctx) =>
      json(
        (
          db
            .prepare(
              "SELECT * FROM accounts WHERE owner_id=? ORDER BY created_at DESC,id",
            )
            .all(owner(ctx)) as any[]
        ).map(metadata),
      ),
    );
    api("POST", "/accounts", async (r, ctx) =>
      json(await save(await readObject(r, 262144), owner(ctx), ctx.signal)),
    );
    api("POST", "/account", async (request, ctx) => {
      const b = await readObject(request),
        r = ownedRow(requiredString(b.id, "id"), owner(ctx));
      if (b.action === "delete") {
        db.prepare("DELETE FROM accounts WHERE id=?").run(r.id);
        affinity.remove(r.id);
        health.remove(r.id);
        return json({ ok: true });
      }
      if (b.action === "update") {
        db.prepare(
          "UPDATE accounts SET name=?,enabled=?,max_concurrency=?,updated_at=? WHERE id=?",
        ).run(
          b.name === undefined
            ? r.name
            : typeof b.name === "string" && !b.name.trim()
              ? (decrypt(r).email ?? subscriptionNames[kind])
              : requiredString(b.name, "name", 254),
          b.enabled === undefined
            ? r.enabled
            : b.enabled === true
              ? 1
              : b.enabled === false
                ? 0
                : fail("invalid_request", "Invalid enabled state"),
          concurrency(b.maxConcurrency ?? r.max_concurrency),
          Date.now(),
          r.id,
        );
        affinity.notify(r.id);
      } else if (b.action === "quota")
        return json(await cancellable(queryOverview(r.id), ctx.signal));
      else if (b.action === "refresh") await resolve(r.id, r.version);
      else if (b.action === "resume") {
        db.prepare(
          "UPDATE accounts SET status='ready',error_code=NULL,cooldown_until=0,health_revision=health_revision+1 WHERE id=?",
        ).run(r.id);
        health.remove(r.id);
      } else if (b.action === "project") {
        if (r.provider !== "antigravity")
          fail("subscription_provider", "仅 Antigravity 支持项目 ID");
        let project = b.projectId;
        if (!project) {
          const token = await resolve(r.id);
          project = await discoverAntigravityProject(
            host,
            token.secret,
            AbortSignal.any([
              stop.signal,
              ctx.signal,
              AbortSignal.timeout(30000),
            ]),
          );
        }
        const current = row(r.id),
          value = decrypt(current);
        value.project_id = requiredString(project, "Project ID", 512);
        db.prepare(
          "UPDATE accounts SET cipher=?,version=version+1,updated_at=? WHERE id=? AND version=?",
        ).run(
          encrypt(r.id, r.provider, value, r.owner_id),
          Date.now(),
          r.id,
          current.version,
        );
      } else fail("invalid_action", "Invalid account action");
      return json(metadata(row(r.id)));
    });
    const scope = (ctx: RequestContext) => ({
      actor: ctx.principal!.id,
      owner: owner(ctx),
    });
    api("GET", "/oauth/providers", (request) =>
      json(oauth.providers(request.url)),
    );
    api("POST", "/oauth/start", async (request, ctx) => {
      const b = await readObject(request),
        provider = subscriptionKind(b.provider ?? kind);
      if (provider !== kind)
        fail("subscription_provider", "订阅账号与提供商不匹配");
      if (b.id && ownedRow(b.id, owner(ctx)).provider !== provider)
        fail("subscription_provider", "无法更改授权提供商");
      return json(
        await oauth.start(
          { ...b, maxConcurrency: concurrency(b.maxConcurrency ?? 2) },
          scope(ctx),
          request.url,
        ),
      );
    });
    api("POST", "/oauth/finish", async (request, ctx) => {
      const b = await readObject(request);
      return json(
        await oauth.finish(
          requiredString(b.id, "id"),
          requiredString(b.callback, "authorization callback", 8192).trim(),
          scope(ctx),
        ),
      );
    });
    api("POST", "/oauth/status", async (request, ctx) => {
      const b = await readObject(request);
      return json(await oauth.status(requiredString(b.id, "id"), scope(ctx)));
    });
    api("POST", "/oauth/cancel", async (request, ctx) => {
      const b = await readObject(request);
      return json(oauth.cancel(requiredString(b.id, "id"), scope(ctx)));
    });
  }
  host.validateConfig((config) => {
    if (config.masterKeyRef !== initialMasterKeyRef)
      fail(
        "restart_required",
        "Changing the vault key requires an offline key migration",
        409,
      );
    oauthConfig(host, kind, config);
  });
  const maintenance = startSubscriptionMaintenance({
    host,
    signal: stop.signal,
    list: () =>
      (
        db
          .prepare(
            "SELECT id,status,cooldown_until FROM accounts WHERE enabled=1 AND status<>'reauthorize'",
          )
          .all() as any[]
      ).map((r) => ({
        id: r.id,
        cooling:
          r.status !== "ready" ||
          r.cooldown_until > Date.now() ||
          health.cooldowns(r.id).length > 0,
      })),
    refresh: (id) => resolve(id, undefined, 300000),
    overview: queryOverview,
  });
  host.cleanup(async () => {
    stop.abort();
    await maintenance();
    await oauth.close();
    await Promise.allSettled([...refreshing.values(), ...checking.values()]);
    leases.clear();
    active.clear();
    db.close();
    master.fill(0);
  });
}
