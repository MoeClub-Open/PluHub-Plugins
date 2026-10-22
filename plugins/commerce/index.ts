import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  definePlugin,
  HostError,
  json,
  readObject,
  requiredString,
} from "@pluhub/sdk";
import type {
  Product,
  PaymentCheckout,
  PaymentEvent,
} from "@pluhub/contracts/commerce";
import { openDatabase, transaction } from "../../lib/storage/sqlite.js";
import { integer } from "../../lib/commerce/money.js";
import { requireAdmin } from "../../lib/admin/access.js";
import { installCommerceAdmin } from "./admin.js";
import { nextPeriod } from "./period.js";
import { supportsCheckout } from "../../lib/commerce/checkout.js";
import { installOrderHistory } from "./history.js";
import {
  installPaymentAdjustments,
  adjustmentMigration,
} from "./adjustments.js";
export default definePlugin({
  async setup(host) {
    const db = openDatabase(join(host.dataDir, "commerce.sqlite"), [
      `
    CREATE TABLE orders(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,provider TEXT NOT NULL,product TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,checkout_url TEXT);
    CREATE TABLE payments(provider TEXT NOT NULL,payment_id TEXT NOT NULL,order_id TEXT NOT NULL,event_id TEXT NOT NULL,PRIMARY KEY(provider,payment_id));
    CREATE TABLE subscriptions(id TEXT PRIMARY KEY,order_id TEXT NOT NULL,status TEXT NOT NULL,period_end INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE outbox(source TEXT PRIMARY KEY,user_id TEXT NOT NULL,amount INTEGER NOT NULL,delivered INTEGER NOT NULL DEFAULT 0);
  `,
      "ALTER TABLE orders ADD COLUMN request_key TEXT; CREATE UNIQUE INDEX orders_request_key ON orders(user_id,request_key) WHERE request_key IS NOT NULL; CREATE INDEX orders_user_time ON orders(user_id,created_at);",
      adjustmentMigration,
    ]);
    host.cleanup(() => db.close());
    const products = () => (host.config().products ?? []) as Product[];
    host.validateConfig((c) => {
      const ids = new Set();
      for (const p of (c.products ?? []) as Product[]) {
        requiredString(p.id, "product id");
        requiredString(p.name, "product name");
        if (ids.has(p.id))
          throw new HostError("invalid_config", "Duplicate product id");
        ids.add(p.id);
        integer(p.paymentMinor, "paymentMinor", 1);
        integer(p.creditMicros, "creditMicros", 1);
        if (
          !/^[a-z]{3}$/.test(p.currency) ||
          !["payment", "subscription"].includes(p.mode) ||
          (p.mode === "subscription" &&
            !["month", "year"].includes(p.interval!))
        )
          throw new HostError(
            "invalid_config",
            "Invalid product currency or interval",
          );
      }
      if (c.publicUrl) {
        const url = new URL(String(c.publicUrl));
        if (
          !["https:", "http:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new HostError("invalid_config", "Invalid public URL");
      }
    });
    let flushing: Promise<void> | undefined;
    function flush(sources?: string[]) {
      if (!flushing)
        flushing = (async () => {
          const attempted = new Map<string, number>(),
            failures = new Map<string, unknown>();
          for (;;) {
            const rows = db
              .prepare("SELECT * FROM outbox WHERE delivered=0")
              .all()
              .filter(
                (row: any) => attempted.get(row.source) !== row.revision,
              ) as any[];
            if (!rows.length) break;
            for (const row of rows) {
              attempted.set(row.source, row.revision);
              try {
                await host.call("billing.payment-state@1", {
                  userId: row.user_id,
                  credit: row.amount,
                  source: row.source,
                  revision: row.revision,
                  debit: row.debit,
                  hold: row.hold,
                });
                db.prepare(
                  "UPDATE outbox SET delivered=1 WHERE source=? AND revision=?",
                ).run(row.source, row.revision);
                failures.delete(row.source);
              } catch (error) {
                failures.set(row.source, error);
              }
            }
          }
          if (failures.size) throw failures.values().next().value;
        })().finally(() => {
          flushing = undefined;
        });
      return sources
        ? flushing.catch((error) => {
            if (
              sources.some((source) =>
                db
                  .prepare(
                    "SELECT 1 FROM outbox WHERE source=? AND delivered=0",
                  )
                  .get(source),
              )
            )
              throw error;
          })
        : flushing;
    }
    const adjustments = installPaymentAdjustments(host, db, flush);
    const timer = setInterval(
      () =>
        void flush().catch(() =>
          host.log("error", "Pending payment delivery; retry scheduled"),
        ),
      5000,
    );
    timer.unref();
    host.cleanup(async () => {
      clearInterval(timer);
      await flushing?.catch(() => {});
    });
    host.provide("commerce.payment@1", async (e: PaymentEvent) => {
      for (const field of ["eventId", "orderId", "paymentId"] as const)
        requiredString(e[field], field, 512);
      integer(e.amount);
      if (
        !["stripe", "epay"].includes(e.provider) ||
        typeof e.currency !== "string" ||
        ![
          "paid",
          "renewed",
          "cancelled",
          "past_due",
          "cancel_scheduled",
        ].includes(e.kind)
      )
        throw new HostError("invalid_payment", "Invalid payment event");
      transaction(db, () => {
        const order = db
          .prepare("SELECT * FROM orders WHERE id=?")
          .get(e.orderId) as any;
        if (!order || order.provider !== e.provider)
          throw new HostError("invalid_payment", "Unknown payment order");
        const p = JSON.parse(order.product) as Product;
        if (
          e.provider === "epay" &&
          p.mode === "subscription" &&
          e.kind === "paid"
        ) {
          e = {
            ...e,
            subscriptionId: "epay-prepaid:" + order.id,
            periodEnd: nextPeriod(Date.now(), p.interval!),
          };
        }
        if (
          e.kind === "cancelled" ||
          e.kind === "past_due" ||
          e.kind === "cancel_scheduled"
        ) {
          if (e.subscriptionId)
            db.prepare(
              "UPDATE subscriptions SET status=? WHERE id=? AND order_id=?",
            ).run(
              e.kind === "cancel_scheduled" ? "cancel_at_period_end" : e.kind,
              e.subscriptionId,
              order.id,
            );
          return;
        }
        if (
          e.amount !== p.paymentMinor ||
          e.currency.toLowerCase() !== p.currency
        )
          throw new HostError(
            "payment_mismatch",
            "Payment amount or currency mismatch",
          );
        if (
          p.mode === "subscription" &&
          (!e.subscriptionId ||
            !Number.isSafeInteger(e.periodEnd) ||
            e.periodEnd! <= 0)
        )
          throw new HostError(
            "invalid_payment",
            "Paid subscription period required",
          );
        const prior = db
          .prepare(
            "SELECT order_id FROM payments WHERE provider=? AND payment_id=?",
          )
          .get(e.provider, e.paymentId) as any;
        if (prior) {
          if (prior.order_id !== order.id)
            throw new HostError(
              "payment_conflict",
              "Payment belongs to another order",
              409,
            );
          return;
        }
        if (p.mode === "payment" && order.status === "paid")
          throw new HostError("payment_conflict", "Order already paid", 409);
        db.prepare("INSERT INTO payments VALUES(?,?,?,?)").run(
          e.provider,
          e.paymentId,
          order.id,
          e.eventId,
        );
        if (e.subscriptionId) {
          const existing = db
            .prepare("SELECT * FROM subscriptions WHERE id=?")
            .get(e.subscriptionId) as any;
          if (existing && existing.order_id !== order.id)
            throw new HostError(
              "payment_conflict",
              "Subscription order mismatch",
              409,
            );
          if (existing && e.periodEnd! <= existing.period_end) return; // delayed or duplicate invoices cannot extend twice
          db.prepare(
            "INSERT INTO subscriptions VALUES(?,?,'active',?) ON CONFLICT(id) DO UPDATE SET status='active',period_end=excluded.period_end",
          ).run(e.subscriptionId, order.id, e.periodEnd!);
        }
        db.prepare("UPDATE orders SET status='paid' WHERE id=?").run(order.id);
        db.prepare(
          "INSERT INTO outbox(source,user_id,amount) VALUES(?,?,?)",
        ).run(
          "payment:" + e.provider + ":" + e.paymentId,
          order.user_id,
          p.creditMicros,
        );
      });
      transaction(db, () => adjustments.link(e.provider, e.paymentId));
      await flush(["payment:" + e.provider + ":" + e.paymentId]);
      return { ok: true };
    });
    host.provide("commerce.entitlements@1", ({ userId }) =>
      db
        .prepare(
          "SELECT s.id,s.status,s.period_end,o.product FROM subscriptions s JOIN orders o ON o.id=s.order_id WHERE o.user_id=? AND s.period_end>?",
        )
        .all(requiredString(userId, "userId"), Date.now())
        .map((r: any) => ({ ...r, product: JSON.parse(r.product) })),
    );
    const cancelling = new Map<string, Promise<void>>();
    async function cancelSubscription(sub: any, signal: AbortSignal) {
      const existing = cancelling.get(sub.id);
      if (existing) return existing;
      const work = (async () => {
        if (sub.provider !== "stripe")
          throw new HostError(
            "manual_renewal",
            "Prepaid plan has no automatic renewal to cancel",
          );
        if (["cancel_at_period_end", "cancelled"].includes(sub.status)) return;
        if (!["active", "past_due"].includes(sub.status))
          throw new HostError(
            "invalid_subscription",
            "This subscription cannot be cancelled in its current state",
            409,
          );
        await host.call(
          "payments.stripe@1",
          { action: "cancel", subscriptionId: sub.id },
          signal,
        );
        db.prepare(
          "UPDATE subscriptions SET status='cancel_at_period_end' WHERE id=?",
        ).run(sub.id);
      })().finally(() => cancelling.delete(sub.id));
      cancelling.set(sub.id, work);
      return work;
    }
    installCommerceAdmin(host, db, cancelSubscription);
    installOrderHistory(host, db);
    const checkouts = new Map<string, Promise<{ id: string; url: string }>>();
    host.api({
      method: "GET",
      path: "/catalog",
      access: "authenticated",
      handle: async () => {
        const providers = [];
        for (const p of ["stripe", "epay"])
          if (
            host.hasCapability("payments." + p + "@1") &&
            (
              await host.call<{ enabled: boolean }>("payments." + p + "@1", {
                action: "status",
              })
            ).enabled
          )
            providers.push(p);
        return json({ products: products(), providers });
      },
    });
    host.api({
      method: "GET",
      path: "/orders",
      access: "authenticated",
      handle: (_r, ctx) =>
        json(
          db
            .prepare(
              "SELECT id,provider,product,status,created_at,checkout_url FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 100",
            )
            .all(ctx.principal!.id)
            .map((r: any) => ({ ...r, product: JSON.parse(r.product) })),
        ),
    });
    host.api({
      method: "GET",
      path: "/subscriptions",
      access: "authenticated",
      handle: (_r, ctx) =>
        json(
          db
            .prepare(
              "SELECT s.*,o.product,o.provider FROM subscriptions s JOIN orders o ON o.id=s.order_id WHERE o.user_id=?",
            )
            .all(ctx.principal!.id)
            .map((r: any) => ({ ...r, product: JSON.parse(r.product) })),
        ),
    });
    host.api({
      method: "POST",
      path: "/checkout",
      access: "authenticated",
      handle: async (r, ctx) => {
        if (!ctx.principal?.session)
          throw new HostError(
            "session_required",
            "Console session required",
            403,
          );
        const b = await readObject(r);
        let product = products().find((p) => p.id === b.productId);
        if (!product)
          throw new HostError("not_found", "Product not found", 404);
        if (!["stripe", "epay"].includes(b.provider))
          throw new HostError("invalid_request", "Unknown payment provider");
        if (
          !host.hasCapability("payments." + b.provider + "@1") ||
          !(
            await host.call<{ enabled: boolean }>(
              "payments." + b.provider + "@1",
              { action: "status" },
              ctx.signal,
            )
          ).enabled
        )
          throw new HostError(
            "payment_unavailable",
            "This payment method is unavailable",
            409,
          );
        if (!supportsCheckout(b.provider, product.currency))
          throw new HostError(
            "unsupported_currency",
            "This payment method does not support the product currency",
            400,
          );
        const publicUrl = requiredString(
          host.config().publicUrl,
          "publicUrl",
          2048,
        ).replace(/\/$/, "");
        const nonce = r.headers.get("idempotency-key");
        if (nonce !== null && !/^[a-zA-Z0-9_.:-]{1,128}$/.test(nonce))
          throw new HostError("invalid_request", "无效支付请求标识");
        const prior = nonce
          ? (db
              .prepare("SELECT * FROM orders WHERE user_id=? AND request_key=?")
              .get(ctx.principal.id, nonce) as any)
          : undefined;
        if (
          prior &&
          (prior.provider !== b.provider ||
            JSON.parse(prior.product).id !== product.id)
        )
          throw new HostError(
            "idempotency_conflict",
            "支付请求标识已用于其他商品或支付方式",
            409,
          );
        if (prior?.status === "paid")
          return json({
            id: prior.id,
            url: publicUrl + "/#/commerce?order=" + prior.id,
          });
        if (prior?.checkout_url)
          return json({ id: prior.id, url: prior.checkout_url });
        const id = prior?.id ?? randomUUID();
        if (prior) product = JSON.parse(prior.product);
        else
          db.prepare(
            "INSERT INTO orders(id,user_id,provider,product,status,created_at,checkout_url,request_key) VALUES(?,?,?,?,'pending',?,NULL,?)",
          ).run(
            id,
            ctx.principal.id,
            b.provider,
            JSON.stringify(product),
            Date.now(),
            nonce,
          );
        const existing = checkouts.get(id);
        if (existing) return json(await existing);
        const work = (async () => {
          try {
            const result = await host.call<{ url: string }>(
              "payments." + b.provider + "@1",
              {
                action: "checkout",
                orderId: id,
                userId: ctx.principal!.id,
                product: product!,
                successUrl: publicUrl + "/#/commerce?order=" + id,
                cancelUrl: publicUrl + "/#/commerce",
              } satisfies PaymentCheckout & { action: string },
              ctx.signal,
            );
            const url = new URL(result.url);
            if (
              !["https:", "http:"].includes(url.protocol) ||
              url.username ||
              url.password
            )
              throw new HostError(
                "invalid_checkout",
                "Invalid checkout URL",
                502,
              );
            db.prepare(
              "UPDATE orders SET checkout_url=?,status=CASE WHEN status='failed' THEN 'pending' ELSE status END WHERE id=?",
            ).run(url.href, id);
            return { id, url: url.href };
          } catch (error) {
            db.prepare(
              "UPDATE orders SET status='failed' WHERE id=? AND status='pending'",
            ).run(id);
            throw error;
          }
        })();
        checkouts.set(id, work);
        try {
          return json(await work);
        } finally {
          checkouts.delete(id);
        }
      },
    });
    host.api({
      method: "POST",
      path: "/cancel",
      access: "authenticated",
      handle: async (r, ctx) => {
        if (!ctx.principal?.session)
          throw new HostError(
            "session_required",
            "Console session required",
            403,
          );
        const b = await readObject(r);
        const sub = db
          .prepare(
            "SELECT s.*,o.provider FROM subscriptions s JOIN orders o ON o.id=s.order_id WHERE s.id=? AND o.user_id=?",
          )
          .get(requiredString(b.id, "id"), ctx.principal.id) as any;
        if (!sub)
          throw new HostError("not_found", "Subscription not found", 404);
        await cancelSubscription(sub, ctx.signal);
        return json({ ok: true });
      },
    });
    host.api({
      method: "POST",
      path: "/retry",
      access: "host.manage",
      handle: async (request, ctx) => {
        await requireAdmin(host, request, ctx);
        const body = request.body ? await readObject(request) : {};
        if (typeof body.reason === "string")
          ctx.state.set("admin.reason", body.reason.slice(0, 256));
        await flush();
        return json({ ok: true });
      },
    });
  },
});
