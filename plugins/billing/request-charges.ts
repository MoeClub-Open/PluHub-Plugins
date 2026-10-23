import { HostError, type Host } from "@pluhub/sdk";
import type { DatabaseSync } from "node:sqlite";
import type { RequestCharge } from "@pluhub/contracts/commerce";

export function installRequestCharges(host: Host, db: DatabaseSync) {
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
        db.prepare(`SELECT r.id,r.user_id,r.status,r.amount,r.receipt,l.amount AS posted
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
            charged:
              row.posted == null
                ? row.status === "released"
                  ? 0
                  : null
                : -row.posted,
            held: ["reserved", "review"].includes(row.status) ? row.amount : 0,
            receipt: row.receipt ? JSON.parse(row.receipt) : undefined,
          },
        ];
      });
    },
  );
}
