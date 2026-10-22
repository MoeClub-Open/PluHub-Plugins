import { randomUUID } from "node:crypto";
import type { PaymentAdjustment } from "@pluhub/contracts/commerce";
import { HostError, requiredString, type Host } from "@pluhub/sdk";

type StripeAPI = (
  path: string,
  form: URLSearchParams | undefined,
  signal: AbortSignal,
) => Promise<any>;
const id = (v: any): string | undefined => (typeof v === "string" ? v : v?.id);
export function installStripeAdjustments(host: Host, api: StripeAPI) {
  let tail = Promise.resolve<unknown>(undefined),
    pending = 0;
  host.cleanup(async () => {
    await tail.catch(() => {});
  });
  function serial<T>(signal: AbortSignal, work: () => Promise<T>) {
    signal.throwIfAborted();
    if (pending >= 32)
      throw new HostError(
        "payment_busy",
        "Payment verification is busy; retry later",
        503,
      );
    pending++;
    const current = tail
      .catch(() => {})
      .then(() => {
        signal.throwIfAborted();
        return work();
      });
    tail = current.finally(() => {
      pending--;
    });
    void tail.catch(() => {});
    return current;
  }
  async function list(
    path: string,
    params: URLSearchParams,
    signal: AbortSignal,
  ) {
    const result: any[] = [],
      cursors = new Set<string>();
    for (;;) {
      const page = await api(path + "?" + params, undefined, signal);
      if (!Array.isArray(page.data) || typeof page.has_more !== "boolean")
        throw new HostError(
          "payment_gateway",
          "Invalid Stripe list response",
          502,
        );
      result.push(...page.data);
      if (!page.has_more) return result;
      const cursor = id(page.data.at(-1));
      if (!cursor || cursors.has(cursor) || result.length >= 10000)
        throw new HostError(
          "payment_gateway",
          "Stripe pagination could not be completed",
          502,
        );
      cursors.add(cursor);
      params.set("starting_after", cursor);
    }
  }
  async function references(
    object: any,
    signal: AbortSignal,
  ): Promise<string[]> {
    let intent = id(object.payment_intent),
      chargeId = id(object.charge);
    const refs = new Set<string>();
    if (chargeId) refs.add(chargeId);
    if (!intent && chargeId) {
      const charge = await api(
        "charges/" + encodeURIComponent(chargeId),
        undefined,
        signal,
      );
      intent = id(charge.payment_intent);
      if (id(charge.invoice)) refs.add(id(charge.invoice)!);
    }
    if (intent) {
      refs.add(intent);
      const invoices = await list(
        "invoice_payments",
        new URLSearchParams({
          "payment[type]": "payment_intent",
          "payment[payment_intent]": intent,
          limit: "100",
        }),
        signal,
      );
      for (const item of invoices)
        if (item.status === "paid" && id(item.invoice))
          refs.add(id(item.invoice)!);
    }
    if (!refs.size || refs.size > 8)
      throw new HostError(
        "payment_gateway",
        "Stripe payment association requires review",
        502,
      );
    return [...refs];
  }
  async function deliver(
    kind: "refund" | "dispute",
    object: any,
    eventId: string,
    signal: AbortSignal,
  ) {
    const refundStatuses: Record<string, PaymentAdjustment["status"]> = {
      pending: "pending",
      requires_action: "pending",
      succeeded: "succeeded",
      failed: "failed",
      canceled: "cancelled",
    };
    const disputeStatuses: Record<string, PaymentAdjustment["status"]> = {
      needs_response: "open",
      under_review: "open",
      warning_needs_response: "open",
      warning_under_review: "open",
      won: "won",
      lost: "lost",
      warning_closed: "closed",
      prevented: "closed",
    };
    await host.call(
      "commerce.payment-adjustment@1",
      {
        provider: "stripe",
        eventId,
        objectId: requiredString(object.id, "Stripe object id", 256),
        kind,
        status:
          (kind === "refund" ? refundStatuses : disputeStatuses)[
            object.status
          ] ?? "review",
        amount: object.amount,
        currency: object.currency,
        references: await references(object, signal),
      } satisfies PaymentAdjustment,
      signal,
    );
  }
  async function recheck(
    kind: "refund" | "dispute",
    objectId: string,
    eventId: string,
    signal: AbortSignal,
  ) {
    const object = await api(
      (kind === "refund" ? "refunds/" : "disputes/") +
        encodeURIComponent(objectId),
      undefined,
      signal,
    );
    if (object.id !== objectId)
      throw new HostError(
        "payment_gateway",
        "Stripe object identity mismatch",
        502,
      );
    await deliver(kind, object, eventId, signal);
  }
  return {
    recheck: (kind: unknown, objectId: unknown, signal: AbortSignal) => {
      if (kind !== "refund" && kind !== "dispute")
        throw new HostError("invalid_request", "Invalid financial case type");
      const key = requiredString(objectId, "objectId", 256);
      return serial(signal, () =>
        recheck(kind, key, "recheck:" + randomUUID(), signal),
      );
    },
    webhook: async (event: any, signal: AbortSignal) => {
      const supported = [
        "refund.created",
        "refund.updated",
        "refund.failed",
        "charge.refunded",
        "charge.dispute.created",
        "charge.dispute.updated",
        "charge.dispute.closed",
        "charge.dispute.funds_withdrawn",
        "charge.dispute.funds_reinstated",
      ];
      if (!supported.includes(event.type)) return false;
      await serial(signal, async () => {
        const objectId = requiredString(
          event.data?.object?.id,
          "Stripe object id",
          256,
        );
        if (event.type === "charge.refunded") {
          const charge = await api(
            "charges/" + encodeURIComponent(objectId),
            undefined,
            signal,
          );
          if (charge.id !== objectId)
            throw new HostError(
              "payment_gateway",
              "Stripe charge identity mismatch",
              502,
            );
          const refunds = await list(
            "refunds",
            new URLSearchParams({ charge: objectId, limit: "100" }),
            signal,
          );
          if (charge.amount_refunded > 0 && !refunds.length)
            throw new HostError(
              "payment_gateway",
              "Refund facts are unavailable",
              502,
            );
          for (const refund of refunds) {
            if (id(refund.charge) !== objectId)
              throw new HostError(
                "payment_gateway",
                "Stripe refund charge mismatch",
                502,
              );
            await deliver("refund", refund, event.id + ":" + refund.id, signal);
          }
        } else
          await recheck(
            event.type.startsWith("refund.") ? "refund" : "dispute",
            objectId,
            event.id,
            signal,
          );
      });
      return true;
    },
  };
}
