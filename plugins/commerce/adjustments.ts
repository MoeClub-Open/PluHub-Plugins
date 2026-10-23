import { paymentProviders } from "./providers.js";
import type { DatabaseSync } from "node:sqlite";
import type { PaymentAdjustment, Product } from "@pluhub/contracts/commerce";
import {
  HostError,
  json,
  readObject,
  requiredString,
  type Host,
} from "@pluhub/sdk";
import { transaction } from "../../lib/storage/sqlite.js";
import { integer } from "../../lib/commerce/money.js";
import {
  requireAdmin,
  adminTarget,
  pageQuery,
} from "../../lib/admin/access.js";

export const adjustmentMigration = `
 ALTER TABLE outbox ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
 ALTER TABLE outbox ADD COLUMN debit INTEGER NOT NULL DEFAULT 0;
 ALTER TABLE outbox ADD COLUMN hold INTEGER NOT NULL DEFAULT 0;
 CREATE TABLE payment_adjustments(provider TEXT NOT NULL,object_id TEXT NOT NULL,kind TEXT NOT NULL,
 status TEXT NOT NULL,amount INTEGER NOT NULL,currency TEXT NOT NULL,refs TEXT NOT NULL,
 payment_id TEXT,order_id TEXT,user_id TEXT,review TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(provider,object_id));
 CREATE INDEX payment_adjustments_payment ON payment_adjustments(provider,payment_id);
 CREATE INDEX payment_adjustments_user ON payment_adjustments(user_id,updated_at);
 CREATE TABLE payment_adjustment_events(provider TEXT NOT NULL,event_id TEXT NOT NULL,object_id TEXT NOT NULL,received_at INTEGER NOT NULL,PRIMARY KEY(provider,event_id));
`;
const identifier = (v: unknown, name: string) => requiredString(v, name, 256);
export function installPaymentAdjustments(
  host: Host,
  db: DatabaseSync,
  flush: (sources?: string[]) => Promise<void>,
) {
  function reconcile(provider: string, paymentId: string) {
    const payment = db
      .prepare(
        "SELECT p.*,o.product,o.user_id FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.provider=? AND p.payment_id=?",
      )
      .get(provider, paymentId) as any;
    if (!payment) return;
    const source = "payment:" + provider + ":" + paymentId;
    const outbox = db
      .prepare("SELECT * FROM outbox WHERE source=?")
      .get(source) as any;
    // An invoice deliberately ignored as a duplicate period did not grant credit.
    if (!outbox) return;
    const p = JSON.parse(payment.product) as Product;
    let debit = 0n,
      hold = 0n;
    for (const item of db
      .prepare(
        "SELECT * FROM payment_adjustments WHERE provider=? AND (payment_id=? OR (review IS NOT NULL AND EXISTS(SELECT 1 FROM json_each(refs) WHERE value=?)))",
      )
      .all(provider, paymentId, paymentId) as any[]) {
      if (
        item.review ||
        item.currency !== p.currency ||
        item.amount > p.paymentMinor ||
        item.status === "review"
      ) {
        db.prepare(
          "UPDATE payment_adjustments SET review=? WHERE provider=? AND object_id=?",
        ).run(
          "Payment amount, currency or status requires review",
          provider,
          item.object_id,
        );
        hold += BigInt(p.paymentMinor);
      } else if (["succeeded", "lost"].includes(item.status))
        debit += BigInt(item.amount);
      else if (["pending", "open"].includes(item.status))
        hold += BigInt(item.amount);
    }
    const total = BigInt(p.paymentMinor),
      credit = BigInt(p.creditMicros);
    if (debit > total) debit = total;
    if (debit + hold > total) hold = total - debit;
    // Round the combined deduction once, so a refund plus its remaining hold never exceeds credit.
    const rounded = (n: bigint) => (n * credit + total - 1n) / total;
    const debitMicros = Number(rounded(debit)),
      holdMicros = Number(rounded(debit + hold) - rounded(debit));
    if (outbox.debit !== debitMicros || outbox.hold !== holdMicros)
      db.prepare(
        "UPDATE outbox SET debit=?,hold=?,revision=revision+1,delivered=0 WHERE source=?",
      ).run(debitMicros, holdMicros, source);
  }
  function link(provider: string, paymentId: string) {
    const candidates = db
      .prepare(
        "SELECT object_id FROM payment_adjustments WHERE provider=? AND (payment_id=? OR EXISTS(SELECT 1 FROM json_each(refs) WHERE value=?))",
      )
      .all(provider, paymentId, paymentId) as any[];
    for (const { object_id } of candidates) {
      const item = db
        .prepare(
          "SELECT * FROM payment_adjustments WHERE provider=? AND object_id=?",
        )
        .get(provider, object_id) as any;
      const refs = JSON.parse(item.refs) as string[];
      const payments = db
        .prepare(
          "SELECT p.payment_id,p.order_id,o.user_id FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.provider=? AND p.payment_id IN (" +
            refs.map(() => "?").join(",") +
            ")",
        )
        .all(provider, ...refs) as any[];
      if (payments.length === 1) {
        const found = payments[0];
        const review = db
          .prepare("SELECT 1 FROM outbox WHERE source=?")
          .get("payment:" + provider + ":" + found.payment_id)
          ? null
          : "Payment did not grant credit";
        db.prepare(
          "UPDATE payment_adjustments SET payment_id=?,order_id=?,user_id=?,review=? WHERE provider=? AND object_id=?",
        ).run(
          found.payment_id,
          found.order_id,
          found.user_id,
          review,
          provider,
          object_id,
        );
      } else
        db.prepare(
          "UPDATE payment_adjustments SET review=? WHERE provider=? AND object_id=?",
        ).run(
          payments.length
            ? "Payment reference is ambiguous"
            : "Payment has not been matched",
          provider,
          object_id,
        );
    }
    reconcile(provider, paymentId);
  }
  host.provide(
    "commerce.payment-adjustment@1",
    async (input: PaymentAdjustment) => {
      const provider = identifier(input.provider, "provider"),
        eventId = requiredString(input.eventId, "eventId", 512),
        objectId = identifier(input.objectId, "objectId");
      if (
        !["refund", "dispute"].includes(input.kind) ||
        !/^[a-z]{3}$/.test(input.currency)
      )
        throw new HostError("invalid_payment", "Invalid payment adjustment");
      const statuses =
        input.kind === "refund"
          ? ["pending", "succeeded", "failed", "cancelled", "review"]
          : ["open", "won", "lost", "closed", "review"];
      if (
        !statuses.includes(input.status) ||
        !Array.isArray(input.references) ||
        !input.references.length ||
        input.references.length > 8
      )
        throw new HostError(
          "invalid_payment",
          "Invalid payment adjustment status or references",
        );
      const refs = [
        ...new Set(
          input.references.map((v) => identifier(v, "payment reference")),
        ),
      ].sort();
      const amount = integer(input.amount, "amount", 1);
      const sources = new Set(
        refs.map((ref) => "payment:" + provider + ":" + ref),
      );
      transaction(db, () => {
        const prior = db
          .prepare(
            "SELECT object_id FROM payment_adjustment_events WHERE provider=? AND event_id=?",
          )
          .get(provider, eventId) as any;
        if (prior) {
          if (prior.object_id !== objectId)
            throw new HostError(
              "idempotency_conflict",
              "Payment event identity changed",
              409,
            );
          return;
        }
        const existing = db
          .prepare(
            "SELECT * FROM payment_adjustments WHERE provider=? AND object_id=?",
          )
          .get(provider, objectId) as any;
        if (
          existing &&
          (existing.kind !== input.kind ||
            existing.amount !== amount ||
            existing.currency !== input.currency ||
            !refs.some((ref) =>
              (JSON.parse(existing.refs) as string[]).includes(ref),
            ))
        )
          throw new HostError(
            "payment_conflict",
            "Adjustment identity changed",
            409,
          );
        db.prepare(
          "INSERT INTO payment_adjustments(provider,object_id,kind,status,amount,currency,refs,review,updated_at) VALUES(?,?,?,?,?,?,?,'Payment has not been matched',?) ON CONFLICT(provider,object_id) DO UPDATE SET status=excluded.status,refs=excluded.refs,updated_at=excluded.updated_at",
        ).run(
          provider,
          objectId,
          input.kind,
          input.status,
          amount,
          input.currency,
          JSON.stringify(refs),
          Date.now(),
        );
        db.prepare("INSERT INTO payment_adjustment_events VALUES(?,?,?,?)").run(
          provider,
          eventId,
          objectId,
          Date.now(),
        );
        const affected = new Set<string>([
          ...refs,
          ...(existing ? (JSON.parse(existing.refs) as string[]) : []),
        ]);
        for (const ref of affected) {
          sources.add("payment:" + provider + ":" + ref);
          link(provider, ref);
        }
        const linked = db
          .prepare(
            "SELECT payment_id FROM payment_adjustments WHERE provider=? AND object_id=?",
          )
          .get(provider, objectId) as any;
        if (linked?.payment_id) reconcile(provider, linked.payment_id);
      });
      const linked = db
        .prepare(
          "SELECT payment_id FROM payment_adjustments WHERE provider=? AND object_id=?",
        )
        .get(provider, objectId) as any;
      if (linked?.payment_id)
        sources.add("payment:" + provider + ":" + linked.payment_id);
      await flush([...sources]);
      return { ok: true };
    },
  );
  for (const admin of [false, true])
    host.api({
      method: "GET",
      path: admin ? "/admin/adjustments" : "/adjustments",
      access: admin ? "host.manage" : "authenticated",
      handle: async (request, ctx) => {
        if (admin) await requireAdmin(host, request, ctx, false);
        const { query, limit, offset, userId, q } = pageQuery(request),
          where: string[] = [],
          values: any[] = [];
        if (!admin || userId) {
          where.push("user_id=?");
          values.push(admin ? userId : ctx.principal!.id);
        }
        if (q) {
          where.push("(object_id LIKE ? OR order_id LIKE ?)");
          values.push("%" + q + "%", "%" + q + "%");
        }
        if (query.has("orderId")) {
          where.push("order_id=?");
          values.push(identifier(query.get("orderId"), "orderId"));
        }
        if (query.get("status")) {
          const status = query.get("status");
          if (status === "review") where.push("review IS NOT NULL");
          else {
            if (
              ![
                "pending",
                "succeeded",
                "failed",
                "cancelled",
                "open",
                "won",
                "lost",
                "closed",
              ].includes(status!)
            )
              throw new HostError(
                "invalid_request",
                "Invalid adjustment status",
              );
            where.push("status=?");
            values.push(status);
          }
        }
        const clause = where.length ? " WHERE " + where.join(" AND ") : "";
        const fields = admin
          ? "provider,object_id,object_id AS id,kind,status,amount,currency,payment_id,order_id,user_id,review,updated_at"
          : "provider,object_id,kind,status,amount,currency,order_id,updated_at";
        return json({
          total: Number(
            (
              db
                .prepare("SELECT COUNT(*) n FROM payment_adjustments" + clause)
                .get(...values) as any
            ).n,
          ),
          items: db
            .prepare(
              "SELECT " +
                fields +
                " FROM payment_adjustments" +
                clause +
                " ORDER BY updated_at DESC,object_id LIMIT ? OFFSET ?",
            )
            .all(...values, limit, offset),
        });
      },
    });
  host.api({
    method: "POST",
    path: "/admin/adjustments/recheck",
    access: "host.manage",
    handle: async (request, ctx) => {
      await requireAdmin(host, request, ctx);
      const body = await readObject(request),
        objectId = identifier(body.id, "id"),
        reason = requiredString(body.reason, "reason", 256);
      const item = db
        .prepare(
          "SELECT * FROM payment_adjustments WHERE provider=? AND object_id=?",
        )
        .get(body.provider, objectId) as any;
      if (!item)
        throw new HostError("not_found", "Payment adjustment not found", 404);
      const providers = paymentProviders(host);
      if (!(await providers.get(item.provider, ctx.signal)).recheckAdjustments)
        throw new HostError(
          "unsupported_operation",
          "Recheck this payment with the merchant before adjusting the user balance",
        );
      adminTarget(ctx, item.user_id ?? "unmatched", objectId, reason);
      await providers.call(
        item.provider,
        { action: "recheck", kind: item.kind, objectId },
        ctx.signal,
      );
      return json({ ok: true });
    },
  });
  return { link };
}
