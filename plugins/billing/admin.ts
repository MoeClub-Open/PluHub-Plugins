import type { DatabaseSync } from "node:sqlite";
import { HostError, json, requiredString, type Host } from "@pluhub/sdk";
import { requireAdmin, pageQuery } from "../../lib/admin/access.js";
export function installBillingAdmin(
  host: Host,
  db: DatabaseSync,
  wallet: (id: string, create?: boolean) => unknown,
) {
  host.api({
    method: "GET",
    path: "/admin/wallet",
    access: "host.manage",
    handle: async (request, ctx) => {
      await requireAdmin(host, request, ctx, false);
      const id = requiredString(
        new URL(request.url).searchParams.get("userId"),
        "userId",
      );
      if (
        host.hasCapability("users.lookup@1") &&
        !(await host.call("users.lookup@1", { id }))
      )
        throw new HostError("not_found", "用户不存在", 404);
      return json(wallet(id, false));
    },
  });
  host.api({
    method: "GET",
    path: "/admin/ledger",
    access: "host.manage",
    handle: async (request, ctx) => {
      await requireAdmin(host, request, ctx, false);
      const { limit, offset, userId, q } = pageQuery(request),
        where: string[] = [],
        values: any[] = [];
      if (userId) {
        where.push("l.user_id=?");
        values.push(userId);
      }
      if (q) {
        where.push("l.source LIKE ?");
        values.push("%" + q + "%");
      }
      const clause = where.length ? " WHERE " + where.join(" AND ") : "";
      return json({
        total: Number(
          (
            db
              .prepare("SELECT COUNT(*) n FROM ledger l" + clause)
              .get(...values) as any
          ).n,
        ),
        items: db
          .prepare(
            "SELECT l.*,a.actor,a.reason,r.receipt FROM ledger l LEFT JOIN adjustments a ON a.source=l.source LEFT JOIN reservations r ON l.source='request:'||r.id" +
              clause +
              " ORDER BY l.id DESC LIMIT ? OFFSET ?",
          )
          .all(...values, limit, offset),
      });
    },
  });
}
