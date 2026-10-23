import { definePlugin, HostError } from "@pluhub/sdk";
import type { PaymentCheckout } from "@pluhub/contracts/commerce";
import { stripeVerify } from "../../lib/commerce/signatures.js";
import { installStripeAdjustments } from "./adjustments.js";
import { paymentSecretStore } from "../../lib/commerce/secret-store.js";
import { stripeCustomers } from "./customers.js";
export default definePlugin({
  setup(host) {
    const secrets = paymentSecretStore(host, [
      "keyRef",
      "webhookSecretRef",
      "previousWebhookSecretRef",
    ] as const);
    host.validateConfig((c) => {
      if (c.enabled) {
        for (const field of ["keyRef", "webhookSecretRef"])
          if (typeof c[field] !== "string")
            throw new HostError("invalid_config", "Missing Stripe " + field);
      }
    });
    function settings() {
      const c = host.config();
      return c as any;
    }
    async function api(
      path: string,
      form: URLSearchParams | undefined,
      signal: AbortSignal,
      idempotency?: string,
    ) {
      const c = settings();
      const response = await host.call<Response>(
        "http.transport@1",
        {
          url: "https://api.stripe.com/v1/" + path,
          method: form ? "POST" : "GET",
          headers: {
            authorization: "Bearer " + secrets.read(c.keyRef, "keyRef"),
            "stripe-version": "2025-03-31.basil",
            ...(form
              ? { "content-type": "application/x-www-form-urlencoded" }
              : {}),
            ...(idempotency ? { "idempotency-key": idempotency } : {}),
          },
          ...(form ? { body: form.toString() } : {}),
        },
        signal,
      );
      if (!response.ok) {
        await response.body?.cancel();
        host.log(
          "warn",
          "Stripe request failed: HTTP " +
            response.status +
            ", request " +
            (response.headers.get("request-id") ?? "unknown"),
        );
        throw new HostError(
          "payment_gateway",
          "Stripe request failed (HTTP " + response.status + ")",
          502,
        );
      }
      return (await response.json()) as any;
    }
    const adjustments = installStripeAdjustments(host, api);
    const customers = stripeCustomers(host, api);
    host.provide(
      "payments.provider@1",
      async (
        input: PaymentCheckout & {
          action: string;
          subscriptionId?: string;
          kind?: string;
          objectId?: string;
          returnUrl?: string;
          subscriptions?: { id: string; orderId: string }[];
        },
        signal,
      ) => {
        if (input.action === "status")
          return {
            id: "stripe",
            name: "Stripe",
            methods: [{ name: "Stripe" }],
            currencies: "*",
            modes: ["payment", "subscription"],
            renewal: "automatic",
            cancelSubscription: true,
            recheckAdjustments: true,
            enabled: host.config().enabled === true,
            customerPortal: host.config().portalEnabled === true,
          };
        if (input.action === "recheck")
          return adjustments.recheck(input.kind, input.objectId, signal);
        if (input.action === "portal")
          return customers.portal(
            input.userId,
            input.returnUrl!,
            signal,
            input.subscriptions,
          );
        if (!["checkout", "cancel", "resume"].includes(input.action))
          throw new HostError(
            "unsupported_operation",
            "Unsupported Stripe operation",
          );
        if (input.action === "cancel" || input.action === "resume")
          return api(
            "subscriptions/" + encodeURIComponent(input.subscriptionId!),
            new URLSearchParams({
              cancel_at_period_end: String(input.action === "cancel"),
            }),
            signal,
          );
        if (!host.config().enabled)
          throw new HostError("payment_disabled", "Stripe is disabled", 503);
        const p = input.product;
        const form = new URLSearchParams({
          mode: p.mode,
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          client_reference_id: input.orderId,
          "metadata[orderId]": input.orderId,
          "line_items[0][quantity]": "1",
          "line_items[0][price_data][currency]": p.currency,
          "line_items[0][price_data][unit_amount]": String(p.paymentMinor),
          "line_items[0][price_data][product_data][name]": p.name,
          customer: await customers.customer(input.userId, signal),
        });
        if (p.mode === "subscription") {
          form.set(
            "line_items[0][price_data][recurring][interval]",
            p.interval!,
          );
          form.set("subscription_data[metadata][orderId]", input.orderId);
        } else
          form.set("payment_intent_data[metadata][orderId]", input.orderId);
        const session = await api(
          "checkout/sessions",
          form,
          signal,
          "checkout:" + input.orderId,
        );
        return { url: session.url };
      },
    );
    host.api({
      method: "POST",
      path: "/webhook",
      access: "public",
      handle: async (request, ctx) => {
        const c = settings();
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (request.body) {
          const reader = request.body.getReader();
          try {
            for (;;) {
              const item = await reader.read();
              if (item.done) break;
              size += item.value.length;
              if (size > 1048576) {
                await reader.cancel();
                throw new HostError("body_too_large", "Webhook too large", 413);
              }
              chunks.push(item.value);
            }
          } finally {
            reader.releaseLock();
          }
        }
        const raw = Buffer.concat(chunks);
        try {
          stripeVerify(
            raw,
            request.headers.get("stripe-signature") ?? "",
            secrets.read(c.webhookSecretRef, "webhookSecretRef"),
          );
        } catch (error) {
          if (!c.previousWebhookSecretRef) throw error;
          stripeVerify(
            raw,
            request.headers.get("stripe-signature") ?? "",
            secrets.read(
              c.previousWebhookSecretRef,
              "previousWebhookSecretRef",
            ),
          );
        }
        const event = JSON.parse(raw.toString("utf8"));
        const obj = event.data?.object;
        if (!obj || typeof event.id !== "string")
          throw new HostError("invalid_request", "Invalid Stripe event");
        if (event.livemode !== (c.livemode === true))
          throw new HostError("invalid_request", "Stripe mode mismatch");
        if (await adjustments.webhook(event, ctx.signal))
          return new Response("ok");
        const id = (v: any) => (typeof v === "string" ? v : v?.id);
        const observedAt = Date.now();
        if (
          [
            "checkout.session.expired",
            "checkout.session.async_payment_failed",
          ].includes(event.type)
        ) {
          const session = await api(
            "checkout/sessions/" + encodeURIComponent(obj.id),
            undefined,
            ctx.signal,
          );
          if (session.payment_status !== "paid" && session.metadata?.orderId)
            await host.call(
              "commerce.payment@1",
              {
                provider: "stripe",
                eventId: event.id,
                orderId: session.metadata.orderId,
                paymentId: session.id,
                amount: 0,
                currency: session.currency ?? "usd",
                kind: session.status === "expired" ? "expired" : "failed",
              },
              ctx.signal,
            );
          return new Response("ok");
        }
        if (
          [
            "checkout.session.completed",
            "checkout.session.async_payment_succeeded",
          ].includes(event.type) &&
          obj.mode === "payment" &&
          obj.payment_status === "paid"
        ) {
          const session = await api(
            "checkout/sessions/" + encodeURIComponent(obj.id),
            undefined,
            ctx.signal,
          );
          if (
            session.payment_status !== "paid" ||
            session.mode !== "payment" ||
            !id(session.payment_intent)
          )
            throw new HostError("invalid_payment", "Unpaid checkout");
          await host.call(
            "commerce.payment@1",
            {
              provider: "stripe",
              eventId: event.id,
              orderId: session.metadata?.orderId,
              paymentId: id(session.payment_intent),
              amount: session.amount_total,
              currency: session.currency,
              kind: "paid",
            },
            ctx.signal,
          );
        } else if (event.type === "invoice.paid") {
          const invoice = await api(
            "invoices/" + encodeURIComponent(obj.id),
            undefined,
            ctx.signal,
          );
          const subscriptionId = id(
            invoice.parent?.subscription_details?.subscription ??
              invoice.subscription,
          );
          if (subscriptionId) {
            const sub = await api(
              "subscriptions/" + encodeURIComponent(subscriptionId),
              undefined,
              ctx.signal,
            );
            if (!sub.metadata?.orderId) return new Response("ok");
            const lines = invoice.lines?.data ?? [];
            const end =
              Math.max(
                0,
                ...lines.map((l: any) => Number(l.period?.end ?? 0)),
              ) * 1000;
            if (invoice.status !== "paid" || invoice.amount_remaining !== 0)
              throw new HostError(
                "invalid_payment",
                "Subscription not active or invoice unpaid",
              );
            await host.call(
              "commerce.payment@1",
              {
                provider: "stripe",
                eventId: event.id,
                orderId: sub.metadata?.orderId,
                paymentId: invoice.id,
                amount: invoice.amount_paid,
                currency: invoice.currency,
                kind: "renewed",
                subscriptionId,
                periodEnd: end,
                subscriptionStatus:
                  sub.status === "canceled"
                    ? "cancelled"
                    : sub.cancel_at_period_end
                      ? "cancel_at_period_end"
                      : sub.status === "active"
                        ? "active"
                        : "past_due",
                observedAt,
              },
              ctx.signal,
            );
          }
        } else if (
          [
            "customer.subscription.deleted",
            "customer.subscription.updated",
            "invoice.payment_failed",
          ].includes(event.type)
        ) {
          const subscriptionId = event.type.startsWith("customer.")
            ? obj.id
            : id(
                obj.parent?.subscription_details?.subscription ??
                  obj.subscription,
              );
          if (subscriptionId) {
            const sub = await api(
              "subscriptions/" + encodeURIComponent(subscriptionId),
              undefined,
              ctx.signal,
            );
            if (sub.metadata?.orderId)
              await host.call(
                "commerce.payment@1",
                {
                  provider: "stripe",
                  eventId: event.id,
                  orderId: sub.metadata?.orderId,
                  paymentId: event.id,
                  amount: 0,
                  currency: "usd",
                  kind:
                    sub.status === "canceled"
                      ? "cancelled"
                      : sub.cancel_at_period_end
                        ? "cancel_scheduled"
                        : sub.status === "active" || sub.status === "trialing"
                          ? "active"
                          : "past_due",
                  subscriptionId,
                  observedAt,
                },
                ctx.signal,
              );
          }
        }
        return new Response("ok");
      },
    });
  },
});
