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
export function installChannelAdmin(
  host: Host,
  db: DatabaseSync,
  metadata: (row: any) => object,
) {
  host.api({
    method: "GET",
    path: "/admin/channels",
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
        where.push("(name LIKE ? OR id LIKE ?)");
        values.push("%" + q + "%", "%" + q + "%");
      }
      const status = query.get("status");
      if (status && !["enabled", "disabled", "blocked"].includes(status))
        throw new HostError("invalid_request", "无效渠道状态");
      if (status === "blocked") where.push("admin_blocked=1");
      if (status === "enabled") where.push("enabled=1 AND admin_blocked=0");
      if (status === "disabled") where.push("enabled=0 AND admin_blocked=0");
      const clause = where.length ? " WHERE " + where.join(" AND ") : "";
      return json({
        total: Number(
          (
            db
              .prepare("SELECT COUNT(*) n FROM personal_channels" + clause)
              .get(...values) as any
          ).n,
        ),
        items: db
          .prepare(
            "SELECT * FROM personal_channels" +
              clause +
              " ORDER BY updated_at DESC,id LIMIT ? OFFSET ?",
          )
          .all(...values, limit, offset)
          .map((r: any) => ({ ...metadata(r), user_id: r.user_id })),
      });
    },
  });
  host.api({
    method: "POST",
    path: "/admin/channels/block",
    access: "users.manage",
    handle: async (request, ctx) => {
      await requireAdmin(host, request, ctx);
      const body = await readObject(request),
        id = requiredString(body.id, "id"),
        userId = requiredString(body.userId, "userId"),
        reason = requiredString(body.reason, "reason", 256);
      if (typeof body.blocked !== "boolean")
        throw new HostError("invalid_request", "blocked 必须为布尔值");
      if (
        !db
          .prepare("SELECT id FROM personal_channels WHERE id=? AND user_id=?")
          .get(id, userId)
      )
        throw new HostError("not_found", "渠道不存在", 404);
      adminTarget(ctx, userId, id, reason);
      db.prepare(
        "UPDATE personal_channels SET admin_blocked=?,admin_note=?,revision=revision+1,updated_at=? WHERE id=? AND user_id=?",
      ).run(
        body.blocked ? 1 : 0,
        body.blocked ? reason : "",
        Date.now(),
        id,
        userId,
      );
      return json({ ok: true });
    },
  });
}
