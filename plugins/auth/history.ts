import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { HostError, type Host, type RequestContext } from "@pluhub/sdk";
import { transaction } from "../../lib/storage/sqlite.js";
import { requireAdmin } from "../../lib/admin/access.js";

export const historyMigration = `CREATE TABLE security_events(
 id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,user_id TEXT,actor_id TEXT,
 action TEXT NOT NULL,outcome TEXT NOT NULL,method TEXT NOT NULL,ip TEXT,device TEXT NOT NULL,
 http_status INTEGER NOT NULL,error_code TEXT,request_id TEXT,resource_id TEXT);
 CREATE INDEX security_events_time ON security_events(created_at,id);
 CREATE INDEX security_events_user_time ON security_events(user_id,created_at,id);`;
const routes: Record<string, [string, string]> = {
  "POST /login": ["login", "password"],
  "POST /login/mfa": ["login", "totp"],
  "POST /email/login": ["login", "email"],
  "POST /passkeys/login/verify": ["login", "passkey"],
  "POST /logout": ["logout", "session"],
  "POST /register": ["register", "email"],
  "POST /reauth": ["identity.confirm", "password"],
  "POST /password": ["password.change", "session"],
  "POST /password/reset": ["password.reset", "email"],
  "POST /password/reset/finish": ["password.reset", "totp"],
  "POST /email/bind": ["email.bind", "session"],
  "POST /totp/confirm": ["totp.enable", "session"],
  "DELETE /totp": ["totp.disable", "session"],
  "POST /recovery-codes": ["recovery.rotate", "session"],
  "POST /passkeys/register/verify": ["passkey.register", "session"],
  "DELETE /passkeys": ["passkey.remove", "session"],
  "POST /sessions/revoke": ["session.revoke", "session"],
  "POST /sessions/revoke-others": ["session.revoke_others", "session"],
  "POST /keys": ["key.create", "session"],
  "PUT /keys/binding": ["key.binding", "session"],
  "DELETE /keys": ["key.revoke", "session"],
  "POST /users": ["account.create", "session"],
  "POST /admin/keys/revoke": ["key.revoke", "session"],
  "POST /admin/sessions/revoke": ["session.revoke_all", "session"],
  "POST /admin/factors/reset": ["factors.reset", "session"],
};
const actions = new Set([
  ...Object.values(routes).map(([action]) => action),
  "password.admin_reset",
  "account.bootstrap",
]);
const methods = new Set([
  "password",
  "email",
  "totp",
  "recovery",
  "passkey",
  "session",
  "internal",
]);
const codes = new Set([
  "invalid_credentials",
  "invalid_factor",
  "invalid_code",
  "invalid_challenge",
  "invalid_webauthn",
  "rate_limited",
  "forbidden",
  "session_required",
  "reauth_required",
  "not_enabled",
  "mail_unavailable",
  "invalid_password",
  "invalid_request",
  "invalid_binding",
  "not_found",
  "credential_exists",
  "user_exists",
  "account_unavailable",
  "session_limit",
  "password_required",
  "confirmation_required",
  "captcha_failed",
  "captcha_unavailable",
]);
type Details = {
  userId?: string;
  actorId?: string;
  method?: string;
  challenge?: boolean;
  resourceId?: string;
};
type Scope = Details & {
  ctx: RequestContext;
  request: Request;
  action: string;
  startedAt: number;
};
const id = (value: unknown) =>
  typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value)
    ? value
    : null;
function device(request: Request) {
  const ua = request.headers.get("user-agent") ?? "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "";
  const platform = /Windows/i.test(ua)
    ? "Windows"
    : /Android/i.test(ua)
      ? "Android"
      : /iPhone|iPad/i.test(ua)
        ? "iOS"
        : /Macintosh/i.test(ua)
          ? "macOS"
          : /Linux/i.test(ua)
            ? "Linux"
            : "";
  return [browser, platform].filter(Boolean).join(" / ");
}
export function installSecurityHistory(rawHost: Host, db: DatabaseSync) {
  const context = new AsyncLocalStorage<Scope>();
  let failures = 0,
    dropped = 0,
    lastFaultAt = -Infinity,
    rowCount = 0,
    writes = 0;
  const settings = () => ({
    retentionDays: Number(rawHost.config().securityHistoryRetentionDays ?? 90),
    maxRows: Number(rawHost.config().securityHistoryMaxRows ?? 100000),
  });
  const fault = (lost: boolean) => {
    failures++;
    if (lost) dropped++;
    if (Date.now() - lastFaultAt >= 30000) {
      lastFaultAt = Date.now();
      try {
        rawHost.log("error", "Account security history storage failed");
      } catch {}
    }
  };
  const unavailable = () =>
    new HostError(
      "security_history_unavailable",
      "安全记录暂不可用，请稍后重试。",
      503,
    );
  function trim(count: number) {
    const { maxRows } = settings();
    if (count > maxRows) {
      db.prepare(
        "DELETE FROM security_events WHERE rowid IN (SELECT rowid FROM security_events ORDER BY created_at,id LIMIT ?)",
      ).run(count - maxRows);
      return maxRows;
    }
    return count;
  }
  function expire() {
    const { retentionDays } = settings();
    db.prepare("DELETE FROM security_events WHERE created_at<?").run(
      Date.now() - retentionDays * 86400000,
    );
    return Number(
      (db.prepare("SELECT COUNT(*) n FROM security_events").get() as any).n,
    );
  }
  function prune() {
    rowCount = transaction(db, () => trim(expire()));
  }
  function status() {
    let available = true;
    try {
      db.prepare("SELECT 1 FROM security_events LIMIT 1").get();
    } catch {
      available = false;
    }
    return { available, dropped, failures, ...settings() };
  }
  function write(event: {
    id: string;
    createdAt: number;
    userId: string | null;
    actorId: string | null;
    action: string;
    outcome: string;
    method: string;
    ip: string | null;
    device: string;
    status: number;
    code: string | null;
    requestId: string | null;
    resourceId?: string | null;
  }) {
    try {
      rowCount = transaction(db, () => {
        const added = Number(
          db
            .prepare(
              "INSERT OR IGNORE INTO security_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              event.id,
              event.createdAt,
              event.userId,
              event.actorId,
              event.action,
              event.outcome,
              event.method,
              event.ip,
              event.device,
              event.status,
              event.code,
              event.requestId,
              event.resourceId ?? null,
            ).changes,
        );
        return trim(++writes % 100 === 0 ? expire() : rowCount + added);
      });
    } catch {
      fault(true);
    }
  }
  function record(scope: Scope, httpStatus: number, error?: unknown) {
    const target =
      httpStatus < 400 &&
      scope.ctx.principal?.session &&
      scope.ctx.principal.permissions.includes("*")
        ? scope.ctx.state.get("admin.userId")
        : undefined;
    const userId = id(target) ?? id(scope.userId);
    const actorId = id(scope.actorId);
    const action =
      scope.action === "password.change" &&
      userId &&
      actorId &&
      userId !== actorId
        ? "password.admin_reset"
        : scope.action;
    const ip = scope.request.headers.get("x-pluhub-peer") ?? "";
    const code = (error as any)?.code;
    write({
      id: scope.ctx.id,
      requestId: scope.ctx.id,
      resourceId:
        id(scope.resourceId) ??
        (httpStatus < 400 ? id(scope.ctx.state.get("admin.resourceId")) : null),
      createdAt: scope.startedAt,
      userId,
      actorId,
      action,
      outcome:
        httpStatus >= 400
          ? "failure"
          : scope.challenge
            ? "challenge"
            : "success",
      method: methods.has(scope.method ?? "") ? scope.method! : "session",
      ip: ip.length <= 64 && isIP(ip) ? ip : null,
      device: device(scope.request),
      status: httpStatus,
      code:
        httpStatus < 400
          ? null
          : codes.has(code)
            ? code
            : httpStatus >= 500
              ? "internal_error"
              : "request_failed",
    });
  }
  const host: Host = {
    ...rawHost,
    api(route) {
      const spec = routes[route.method.toUpperCase() + " " + route.path];
      if (!spec) return rawHost.api(route);
      rawHost.api({
        ...route,
        handle(request, ctx) {
          const scope: Scope = {
            request,
            ctx,
            action: spec[0],
            method: spec[1],
            startedAt: Date.now(),
            userId: ctx.principal?.id,
            actorId: ctx.principal?.session ? ctx.principal.id : undefined,
          };
          return context.run(scope, async () => {
            try {
              const response = await route.handle(request, ctx);
              record(scope, response.status);
              return response;
            } catch (error) {
              const value = (error as any)?.status;
              record(
                scope,
                Number.isInteger(value) && value >= 400 && value <= 599
                  ? value
                  : 500,
                error,
              );
              throw error;
            }
          });
        },
      });
    },
  };
  function tag(details: Details) {
    const scope = context.getStore();
    if (scope)
      for (const [key, value] of Object.entries(details))
        if (value !== undefined) Object.assign(scope, { [key]: value });
  }
  function local(
    action: "password.admin_reset" | "account.bootstrap" | "factors.reset",
    userId: string,
  ) {
    if (context.getStore()) {
      tag({ userId });
      return;
    }
    write({
      id: randomUUID(),
      requestId: null,
      createdAt: Date.now(),
      userId: id(userId),
      actorId: null,
      action,
      outcome: "success",
      method: "internal",
      ip: null,
      device: "",
      status: 200,
      code: null,
    });
  }
  function read(request: Request, userId?: string) {
    const query = new URL(request.url).searchParams;
    const limit = Number(query.get("limit") ?? 20),
      offset = Number(query.get("offset") ?? 0);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new HostError(
        "invalid_request",
        "Invalid security history pagination",
      );
    const where: string[] = [],
      values: (string | number)[] = [];
    if (
      userId &&
      ((query.get("userId") && query.get("userId") !== userId) ||
        query.get("actorId"))
    )
      throw new HostError(
        "forbidden",
        "Cannot read another account security history",
        403,
      );
    for (const [column, value] of [
      ["user_id", userId ?? query.get("userId")],
      ["actor_id", query.get("actorId")],
      ["request_id", query.get("requestId")],
    ] as const) {
      if (!value) continue;
      if (value.length > 128 || /[\u0000-\u001f\u007f]/.test(value))
        throw new HostError(
          "invalid_request",
          "Invalid security history filter",
        );
      where.push(column + "=?");
      values.push(value);
    }
    for (const [key, accepted] of [
      ["action", actions],
      ["outcome", new Set(["success", "failure", "challenge"])],
      ["method", methods],
    ] as const) {
      const value = query.get(key);
      if (!value) continue;
      if (!accepted.has(value))
        throw new HostError(
          "invalid_request",
          "Invalid security history filter",
        );
      where.push(key + "=?");
      values.push(value);
    }
    const time = (key: "from" | "to") => {
      const value = query.get(key);
      if (!value) return;
      const number = Number(value);
      if (
        !/^\d{1,16}$/.test(value) ||
        !Number.isSafeInteger(number) ||
        number > 8640000000000000
      )
        throw new HostError(
          "invalid_request",
          "Invalid security history time range",
        );
      where.push("created_at" + (key === "from" ? ">=?" : "<=?"));
      values.push(number);
      return number;
    };
    const from = time("from"),
      to = time("to");
    if (from !== undefined && to !== undefined && from > to)
      throw new HostError(
        "invalid_request",
        "Invalid security history time range",
      );
    try {
      prune();
      const clause = where.length ? " WHERE " + where.join(" AND ") : "";
      const items = db
        .prepare(
          "SELECT * FROM security_events" +
            clause +
            " ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",
        )
        .all(...values, limit, offset)
        .map((row) => {
          if (!userId) return row;
          const { user_id, actor_id, ...own } = row;
          const otherActor = !!actor_id && actor_id !== userId;
          return {
            ...own,
            other_actor: otherActor,
            ...(otherActor ? { ip: null, device: "" } : {}),
          };
        });
      return {
        items,
        total: Number(
          (
            db
              .prepare("SELECT COUNT(*) n FROM security_events" + clause)
              .get(...values) as any
          ).n,
        ),
        storage: status(),
      };
    } catch {
      fault(false);
      throw unavailable();
    }
  }
  rawHost.provide("auth.security-history@1", status);
  rawHost.api({
    method: "GET",
    path: "/security/history",
    access: "authenticated",
    handle(request, ctx) {
      if (!ctx.principal?.session)
        throw new HostError(
          "session_required",
          "Sign in to view security history",
          403,
        );
      return Response.json(read(request, ctx.principal.id), {
        headers: { "cache-control": "no-store" },
      });
    },
  });
  rawHost.api({
    method: "GET",
    path: "/admin/security-history",
    access: "host.manage",
    async handle(request, ctx) {
      await requireAdmin(rawHost, request, ctx, false);
      return Response.json(read(request), {
        headers: { "cache-control": "no-store" },
      });
    },
  });
  rawHost.api({
    method: "GET",
    path: "/admin/security-history/status",
    access: "host.manage",
    async handle(request, ctx) {
      await requireAdmin(rawHost, request, ctx, false);
      return Response.json(status(), {
        headers: { "cache-control": "no-store" },
      });
    },
  });
  const timer = setInterval(() => {
    try {
      prune();
    } catch {
      fault(false);
    }
  }, 60000);
  timer.unref();
  rawHost.cleanup(() => clearInterval(timer));
  try {
    prune();
  } catch {
    fault(false);
  }
  return { host, tag, local };
}
