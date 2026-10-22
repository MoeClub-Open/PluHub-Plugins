import type { DatabaseSync } from "node:sqlite";
import { HostError, json, type Host } from "@pluhub/sdk";
import { pageQuery } from "../../lib/admin/access.js";

export function installOrderHistory(host: Host, db: DatabaseSync) {
  host.api({
    method: "GET",
    path: "/orders/history",
    access: "authenticated",
    handle(request, ctx) {
      const { query, limit, offset, q } = pageQuery(request),
        where = ["user_id=?"],
        params: (string | number)[] = [ctx.principal!.id];
      const status = query.get("status");
      if (status) {
        if (!["pending", "paid", "failed"].includes(status))
          throw new HostError("invalid_request", "无效订单状态");
        where.push("status=?");
        params.push(status);
      }
      if (q) {
        where.push(
          "(id LIKE ? ESCAPE '\\' OR json_extract(product,'$.name') LIKE ? ESCAPE '\\')",
        );
        const pattern = "%" + q.replaceAll(/[%_\\]/g, (c) => "\\" + c) + "%";
        params.push(pattern, pattern);
      }
      const sql = where.join(" AND ");
      const total = Number(
        (
          db
            .prepare("SELECT COUNT(*) n FROM orders WHERE " + sql)
            .get(...params) as any
        ).n,
      );
      const items = (
        db
          .prepare(
            "SELECT id,provider,payment_method,payment_method_name,product,status,created_at,checkout_url,(SELECT COUNT(*) FROM payment_adjustments a WHERE a.order_id=orders.id) AS adjustmentCount FROM orders WHERE " +
              sql +
              " ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",
          )
          .all(...params, limit, offset) as any[]
      ).map((row) => ({ ...row, product: JSON.parse(row.product) }));
      return json({ items, total, limit, offset });
    },
  });
}
