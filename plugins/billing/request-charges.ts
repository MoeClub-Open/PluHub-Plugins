import { HostError, type Host } from "@pluhub/sdk";
import type { DatabaseSync } from "node:sqlite";
import type {
  RequestCharge,
  RequestChargeTotals,
} from "@pluhub/contracts/commerce";

export function installRequestCharges(host: Host, db: DatabaseSync) {
  host.provide(
    "billing.request-totals@1",
    ({
      requests,
    }: {
      requests: { id: string; userId: string }[];
    }): RequestChargeTotals => {
      if (!Array.isArray(requests) || requests.length > 5000)
        throw new HostError(
          "invalid_request",
          "Expected at most 5000 request identities",
        );
      return db
        .prepare(
          `
        WITH identities AS (
          SELECT DISTINCT json_extract(value,'$.id') id, json_extract(value,'$.userId') user_id
          FROM json_each(?)
        )
        SELECT COALESCE(SUM(l.amount IS NOT NULL OR r.status='released'),0) knownRequests,
          COALESCE(SUM(r.status='reserved'),0) pendingRequests,
          COALESCE(SUM(-l.amount),0) charged,
          COALESCE(SUM(CASE WHEN r.status='reserved' THEN r.amount ELSE 0 END),0) held
        FROM identities i JOIN reservations r ON r.id=i.id AND r.user_id=i.user_id
        LEFT JOIN ledger l ON l.source='request:'||r.id AND l.user_id=r.user_id
      `,
        )
        .get(JSON.stringify(requests)) as unknown as RequestChargeTotals;
    },
  );
  host.provide(
    "billing.request-charges@1",
    ({
      requests,
    }: {
      requests: { id: string; userId: string }[];
    }): RequestCharge[] => {
      if (!Array.isArray(requests) || requests.length > 500)
        throw new HostError(
          "invalid_request",
          "Expected at most 500 request identities",
        );
      const find =
        db.prepare(`SELECT r.id,r.user_id,r.status,r.amount,r.receipt,r.note,l.amount AS posted
      FROM reservations r LEFT JOIN ledger l ON l.source='request:'||r.id AND l.user_id=r.user_id
      WHERE r.id=? AND r.user_id=?`);
      return requests.flatMap(({ id, userId }) => {
        const row = find.get(id, userId) as any;
        if (!row) return [];
        return [
          {
            requestId: row.id,
            userId: row.user_id,
            status: row.status,
            note: row.note ?? undefined,
            charged:
              row.posted == null
                ? row.status === "released"
                  ? 0
                  : null
                : -row.posted,
            held: row.status === "reserved" ? row.amount : 0,
            receipt: row.receipt ? JSON.parse(row.receipt) : undefined,
          },
        ];
      });
    },
  );
}
