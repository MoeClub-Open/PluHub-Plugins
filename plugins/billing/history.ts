import type { DatabaseSync } from "node:sqlite";
import { HostError, json, type Host } from "@pluhub/sdk";
import { pageQuery } from "../../lib/admin/access.js";
import { csvResponse, exportGuard } from "../../lib/export/csv.js";

export function installBillingHistory(host: Host, db: DatabaseSync) {
  const guard = exportGuard();
  for (const exporting of [false, true])
    host.api({
      method: "GET",
      path: exporting ? "/ledger/export" : "/ledger/history",
      access: "authenticated",
      handle(request, ctx) {
        const { query, limit, offset, q } = pageQuery(request);
        const where = ["l.user_id=?"],
          params: (string | number)[] = [ctx.principal!.id];
        if (q) {
          where.push("l.source LIKE ? ESCAPE '\\'");
          params.push("%" + q.replaceAll(/[%_\\]/g, (c) => "\\" + c) + "%");
        }
        const kind = query.get("kind");
        if (kind) {
          if (!["credit", "debit"].includes(kind))
            throw new HostError("invalid_request", "无效账单类型");
          where.push(kind === "credit" ? "l.amount>0" : "l.amount<0");
        }
        for (const name of ["from", "to"])
          if (query.has(name)) {
            const value = Number(query.get(name));
            if (!query.get(name) || !Number.isSafeInteger(value) || value < 0)
              throw new HostError("invalid_request", "无效时间范围");
            where.push(name === "from" ? "l.created_at>=?" : "l.created_at<=?");
            params.push(value);
          }
        if (
          query.has("from") &&
          query.has("to") &&
          Number(query.get("from")) > Number(query.get("to"))
        )
          throw new HostError("invalid_request", "无效时间范围");
        const sql = where.join(" AND ");
        const total = Number(
          (
            db
              .prepare("SELECT COUNT(*) n FROM ledger l WHERE " + sql)
              .get(...params) as any
          ).n,
        );
        if (exporting) {
          guard(ctx.principal!.id);
          if (total > 10000)
            throw new HostError(
              "export_too_large",
              "记录超过 10000 条，请缩小筛选范围后导出",
              413,
            );
        }
        const items = db
          .prepare(
            "SELECT l.id,l.amount,l.source,l.created_at,r.receipt FROM ledger l LEFT JOIN reservations r ON l.source='request:'||r.id WHERE " +
              sql +
              " ORDER BY l.id DESC LIMIT ? OFFSET ?",
          )
          .all(
            ...params,
            exporting ? 10000 : limit,
            exporting ? 0 : offset,
          ) as any[];
        if (!exporting) return json({ items, total, limit, offset });
        return csvResponse(
          "pluhub-ledger.csv",
          ["id", "created_at", "source", "amount_micro_usd", "currency"],
          items.map((r) => [
            r.id,
            new Date(r.created_at).toISOString(),
            r.source,
            r.amount,
            "USD",
          ]),
        );
      },
    });
}
