import { randomUUID, createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  HostError,
  json,
  readObject,
  requiredString,
  type Host,
  type RequestContext,
} from "@pluhub/sdk";

export const sessionMigration = `
  ALTER TABLE sessions ADD COLUMN id TEXT;
  ALTER TABLE sessions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN last_active_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN device TEXT NOT NULL DEFAULT '';
  ALTER TABLE sessions ADD COLUMN ip TEXT NOT NULL DEFAULT '';
  ALTER TABLE sessions ADD COLUMN method TEXT NOT NULL DEFAULT 'legacy';
  UPDATE sessions SET id=lower(hex(randomblob(16)));
  CREATE UNIQUE INDEX sessions_id ON sessions(id);
  CREATE INDEX sessions_user_expiry ON sessions(user_id,expires);
`;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const token = (r: Request) =>
  /(?:^|;\s*)pluhub_session=([a-zA-Z0-9_-]+)/.exec(
    r.headers.get("cookie") ?? "",
  )?.[1] ?? "";

export function installSessions(
  host: Host,
  db: DatabaseSync,
  recent: (request: Request, ctx: RequestContext) => string,
  resource: (id: string) => void = () => {},
) {
  const session = (request: Request, ctx: RequestContext) => {
    if (!ctx.principal?.session)
      throw new HostError("session_required", "请登录后管理登录设备", 403);
    return { userId: ctx.principal.id, current: hash(token(request)) };
  };
  host.api({
    method: "GET",
    path: "/sessions",
    access: "authenticated",
    handle(request, ctx) {
      const { userId, current } = session(request, ctx);
      const items = (
        db
          .prepare(
            "SELECT id,created_at,last_active_at,expires,device,ip,method,hash=? AS current FROM sessions WHERE user_id=? AND expires>? ORDER BY current DESC,last_active_at DESC,id LIMIT 100",
          )
          .all(current, userId, Date.now()) as any[]
      ).map((row) => ({ ...row, current: !!row.current }));
      const response = json({ items, maxActive: 50 });
      response.headers.set("cache-control", "no-store");
      return response;
    },
  });
  host.api({
    method: "POST",
    path: "/sessions/revoke",
    access: "authenticated",
    async handle(request, ctx) {
      const { userId, current } = session(request, ctx);
      const body = await readObject(request),
        id = requiredString(body.id, "id", 128);
      const row = db
        .prepare(
          "SELECT hash FROM sessions WHERE id=? AND user_id=? AND expires>?",
        )
        .get(id, userId, Date.now()) as any;
      if (!row) throw new HostError("not_found", "登录设备不存在", 404);
      if (row.hash !== current) recent(request, ctx);
      db.prepare("DELETE FROM sessions WHERE id=? AND user_id=?").run(
        id,
        userId,
      );
      resource(id);
      const response = json({ ok: true, current: row.hash === current });
      response.headers.set("cache-control", "no-store");
      if (row.hash === current)
        response.headers.set(
          "set-cookie",
          "pluhub_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" +
            (host.config().secureCookie ? "; Secure" : ""),
        );
      return response;
    },
  });
  host.api({
    method: "POST",
    path: "/sessions/revoke-others",
    access: "authenticated",
    handle(request, ctx) {
      const { userId, current } = session(request, ctx);
      recent(request, ctx);
      const result = db
        .prepare("DELETE FROM sessions WHERE user_id=? AND hash<>?")
        .run(userId, current);
      return json({ ok: true, revoked: Number(result.changes) });
    },
  });
}

export function createSession(
  db: DatabaseSync,
  value: {
    hash: string;
    userId: string;
    credentialId?: string;
    request?: Request;
    method: string;
  },
) {
  const now = Date.now();
  db.prepare("DELETE FROM sessions WHERE user_id=? AND expires<=?").run(
    value.userId,
    now,
  );
  if (
    Number(
      (
        db
          .prepare("SELECT COUNT(*) n FROM sessions WHERE user_id=?")
          .get(value.userId) as any
      ).n,
    ) >= 50
  )
    throw new HostError(
      "session_limit",
      "登录设备已达上限，请先退出其他设备",
      409,
    );
  db.prepare(
    "INSERT INTO sessions(hash,user_id,expires,auth_at,credential_id,id,created_at,last_active_at,device,ip,method) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    value.hash,
    value.userId,
    now + 7 * 86400000,
    now,
    value.credentialId ?? null,
    randomUUID(),
    now,
    now,
    (value.request?.headers.get("user-agent") ?? "").slice(0, 256),
    (value.request?.headers.get("x-pluhub-peer") ?? "").slice(0, 64),
    value.method,
  );
}
