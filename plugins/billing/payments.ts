import type { DatabaseSync } from "node:sqlite";
import type { PaymentBalanceState } from "@pluhub/contracts/commerce";
import { HostError, requiredString, type Host } from "@pluhub/sdk";
import { integer } from "../../lib/commerce/money.js";
import { transaction } from "../../lib/storage/sqlite.js";

export const paymentMigration = `CREATE TABLE payment_balances(
 source TEXT PRIMARY KEY,user_id TEXT NOT NULL,credit INTEGER NOT NULL,
 debit INTEGER NOT NULL,hold INTEGER NOT NULL,revision INTEGER NOT NULL);
 CREATE INDEX payment_balances_user ON payment_balances(user_id);`;

export function installPaymentBalances(
  host: Host,
  db: DatabaseSync,
  post: (userId: string, amount: number, source: string) => void,
  wallet: (id: string) => unknown,
) {
  host.provide("billing.payment-state@1", (input: PaymentBalanceState) => {
    const userId = requiredString(input.userId, "userId"),
      source = requiredString(input.source, "source", 512);
    if (!source.startsWith("payment:"))
      throw new HostError(
        "invalid_request",
        "A payment credit source is required",
      );
    const credit = integer(input.credit, "credit", 1),
      debit = integer(input.debit, "debit"),
      hold = integer(input.hold, "hold"),
      revision = integer(input.revision, "revision");
    if (BigInt(debit) + BigInt(hold) > BigInt(credit))
      throw new HostError(
        "invalid_request",
        "Payment deductions exceed the original credit",
      );
    return transaction(db, () => {
      const current = db
        .prepare("SELECT * FROM payment_balances WHERE source=?")
        .get(source) as any;
      if (current && (current.user_id !== userId || current.credit !== credit))
        throw new HostError(
          "idempotency_conflict",
          "Payment credit identity changed",
          409,
        );
      if (current && current.revision >= revision) {
        if (
          current.revision === revision &&
          (current.debit !== debit || current.hold !== hold)
        )
          throw new HostError(
            "idempotency_conflict",
            "Payment state revision reused",
            409,
          );
        return wallet(userId);
      }
      post(userId, credit, source);
      const delta = (current?.debit ?? 0) - debit;
      if (delta)
        post(
          userId,
          delta,
          "payment-state:" + source.slice(8) + ":" + revision,
        );
      db.prepare(
        "INSERT INTO payment_balances VALUES(?,?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET debit=excluded.debit,hold=excluded.hold,revision=excluded.revision",
      ).run(source, userId, credit, debit, hold, revision);
      return wallet(userId);
    });
  });
}
