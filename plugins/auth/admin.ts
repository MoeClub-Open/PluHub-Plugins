import type { DatabaseSync } from "node:sqlite";
import {
  HostError,
  json,
  readObject,
  requiredString,
  type Host,
} from "@pluhub/sdk";
import {
  requireAdmin,
  adminTarget,
  pageQuery,
} from "../../lib/admin/access.js";

export function installAdmin(host: Host, db: DatabaseSync) {
  host.api({
    method: "GET",
    path: "/admin/user",
    access: "users.manage",
    handle: async (request, ctx) => {
      await requireAdmin(host, request, ctx, false);
      const userId = requiredString(
        new URL(request.url).searchParams.get("userId"),
        "userId",
      );
      const user = await host.call<any>("users.lookup@1", { id: userId });
      if (!user) throw new HostError("not_found", "用户不存在", 404);
      const count = (table: string, clause = "", args: any[] = []) =>
        Number(
          (
            db
              .prepare(
                "SELECT COUNT(*) n FROM " + table + " WHERE user_id=?" + clause,
              )
              .get(userId, ...args) as any
          ).n,
        );
      return json({
        ...user,
        email:
          (
            db
              .prepare("SELECT email FROM email_credentials WHERE user_id=?")
              .get(userId) as any
          )?.email ?? null,
        passwordSet: count("passwords") > 0,
        totpEnabled: count("totp_credentials") > 0,
        passkeyCount: count("passkeys"),
        sessions: count("sessions", " AND expires>?", [Date.now()]),
        keys: count("api_keys"),
        activeKeys: count(
          "api_keys",
          " AND (expires_at IS NULL OR expires_at>?)",
          [Date.now()],
        ),
      });
    },
  });
  host.api({
    method: "GET",
    path: "/admin/keys",
    access: "users.manage",
    handle: async (request, ctx) => {
      await requireAdmin(host, request, ctx, false);
      const { query, limit, offset, userId, q } = pageQuery(request),
        where: string[] = [],
        values: any[] = [];
      if (userId) {
        where.push("user_id=?");
        values.push(userId);
      }
      if (q) {
        where.push("(name LIKE ? OR prefix LIKE ?)");
        values.push("%" + q + "%", "%" + q + "%");
      }
      const status = query.get("status");
      if (status && !["active", "expired"].includes(status))
        throw new HostError("invalid_request", "无效密钥状态");
      if (status === "active") {
        where.push("(expires_at IS NULL OR expires_at>?)");
        values.push(Date.now());
      }
      if (status === "expired") {
        where.push("expires_at<=?");
        values.push(Date.now());
      }
      const clause = where.length ? " WHERE " + where.join(" AND ") : "";
      const items = db
        .prepare(
          "SELECT id,user_id,name,prefix,created_at,models_json,expires_at,requests_per_minute,last_used_at,channel_id FROM api_keys" +
            clause +
            " ORDER BY created_at DESC,id LIMIT ? OFFSET ?",
        )
        .all(...values, limit, offset)
        .map((row: any) => {
          const { models_json, ...key } = row;
          return { ...key, models: JSON.parse(models_json) };
        });
      return json({
        total: Number(
          (
            db
              .prepare("SELECT COUNT(*) n FROM api_keys" + clause)
              .get(...values) as any
          ).n,
        ),
        items,
      });
    },
  });
  host.api({
    method: "POST",
    path: "/admin/keys/revoke",
    access: "users.manage",
    handle: async (request, ctx) => {
      await requireAdmin(host, request, ctx);
      const body = await readObject(request),
        id = requiredString(body.id, "id"),
        userId = requiredString(body.userId, "userId");
      requiredString(body.reason, "reason", 256);
      adminTarget(ctx, userId, id, body.reason);
      if (
        !db
          .prepare("DELETE FROM api_keys WHERE id=? AND user_id=?")
          .run(id, userId).changes
      )
        throw new HostError("not_found", "密钥不存在或已撤销", 404);
      return json({ ok: true });
    },
  });
  host.api({
    method: "POST",
    path: "/admin/sessions/revoke",
    access: "users.manage",
    handle: async (request, ctx) => {
      await requireAdmin(host, request, ctx);
      const body = await readObject(request),
        userId = requiredString(body.userId, "userId");
      adminTarget(
        ctx,
        userId,
        undefined,
        typeof body.reason === "string" ? body.reason : undefined,
      );
      if (!(await host.call("users.lookup@1", { id: userId })))
        throw new HostError("not_found", "用户不存在", 404);
      const removed = db
        .prepare("DELETE FROM sessions WHERE user_id=?")
        .run(userId).changes;
      db.prepare("DELETE FROM auth_challenges WHERE user_id=?").run(userId);
      return json({ ok: true, removed: Number(removed) });
    },
  });
  host.api({
    method: "POST",
    path: "/admin/factors/reset",
    access: "users.manage",
    handle: async (request, ctx) => {
      await requireAdmin(host, request, ctx);
      const body = await readObject(request),
        userId = requiredString(body.userId, "userId");
      adminTarget(
        ctx,
        userId,
        undefined,
        typeof body.reason === "string" ? body.reason : undefined,
      );
      const user = await host.call<any>("users.lookup@1", { id: userId });
      if (!user) throw new HostError("not_found", "用户不存在", 404);
      if (body.confirmUsername !== user.username)
        throw new HostError(
          "confirmation_required",
          "请输入目标用户名确认重置",
        );
      if (!db.prepare("SELECT 1 FROM passwords WHERE user_id=?").get(userId))
        throw new HostError(
          "password_required",
          "请先为用户设置新密码，避免移除其最后的登录方式",
          409,
        );
      await host.call("auth.reset-factors@1", { username: user.username });
      return json({ ok: true });
    },
  });
}
