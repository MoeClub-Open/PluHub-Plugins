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
export function installCommerceAdmin(
  host: Host,
  db: DatabaseSync,
  cancel: (sub: any, signal: AbortSignal) => Promise<void>,
) {
  for (const kind of ["orders", "subscriptions", "outbox"] as const)
    host.api({
      method: "GET",
      path: "/admin/" + kind,
      access: "host.manage",
      handle: async (request, ctx) => {
        await requireAdmin(host, request, ctx, false);
        const { query, limit, offset, userId, q } = pageQuery(request),
          where: string[] = [],
          values: any[] = [];
        const userField = kind === "outbox" ? "x.user_id" : "o.user_id",
          idField =
            kind === "subscriptions"
              ? "s.id"
              : kind === "outbox"
                ? "x.source"
                : "o.id";
        if (userId) {
          where.push(userField + "=?");
          values.push(userId);
        }
        if (q) {
          where.push(idField + " LIKE ?");
          values.push("%" + q + "%");
        }
        const status = query.get("status");
        if (status) {
          const allowed =
            kind === "orders"
              ? ["pending", "paid", "failed"]
              : kind === "subscriptions"
                ? ["active", "past_due", "cancel_at_period_end", "cancelled"]
                : ["pending", "delivered"];
          if (!allowed.includes(status))
            throw new HostError("invalid_request", "无效状态");
          where.push(
            kind === "outbox"
              ? "x.delivered=?"
              : kind === "orders"
                ? "o.status=?"
                : "s.status=?",
          );
          values.push(
            kind === "outbox" ? (status === "delivered" ? 1 : 0) : status,
          );
        }
        const from =
          kind === "orders"
            ? "orders o"
            : kind === "subscriptions"
              ? "subscriptions s JOIN orders o ON o.id=s.order_id"
              : "outbox x";
        const fields =
          kind === "orders"
            ? "o.id,o.user_id,o.provider,o.payment_method_name,o.product,o.status,o.created_at"
            : kind === "subscriptions"
              ? "s.*,o.user_id,o.provider,o.payment_method_name,o.product"
              : "x.*";
        const order =
          kind === "orders"
            ? "o.created_at DESC,o.id"
            : kind === "subscriptions"
              ? "s.period_end DESC,s.id"
              : "x.delivered,x.source";
        const clause = where.length ? " WHERE " + where.join(" AND ") : "";
        const items = db
          .prepare(
            "SELECT " +
              fields +
              " FROM " +
              from +
              clause +
              " ORDER BY " +
              order +
              " LIMIT ? OFFSET ?",
          )
          .all(...values, limit, offset)
          .map((row: any) =>
            row.product ? { ...row, product: JSON.parse(row.product) } : row,
          );
        return json({
          total: Number(
            (
              db
                .prepare("SELECT COUNT(*) n FROM " + from + clause)
                .get(...values) as any
            ).n,
          ),
          items,
        });
      },
    });
  host.api({
    method: "POST",
    path: "/admin/subscriptions/cancel",
    access: "host.manage",
    handle: async (request, ctx) => {
      await requireAdmin(host, request, ctx);
      const body = await readObject(request),
        id = requiredString(body.id, "id"),
        userId = requiredString(body.userId, "userId"),
        reason = requiredString(body.reason, "reason", 256);
      adminTarget(ctx, userId, id, reason);
      const sub = db
        .prepare(
          "SELECT s.*,o.provider FROM subscriptions s JOIN orders o ON o.id=s.order_id WHERE s.id=? AND o.user_id=?",
        )
        .get(id, userId);
      if (!sub) throw new HostError("not_found", "订阅不存在", 404);
      await cancel(sub, ctx.signal);
      return json({ ok: true });
    },
  });
}
