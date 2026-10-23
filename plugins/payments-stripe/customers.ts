import { join } from "node:path";
import { HostError, type Host } from "@pluhub/sdk";
import { openDatabase } from "../../lib/storage/sqlite.js";
type API = (
  path: string,
  form: URLSearchParams | undefined,
  signal: AbortSignal,
  idempotency?: string,
) => Promise<any>;
export function stripeCustomers(host: Host, api: API) {
  const db = openDatabase(join(host.dataDir, "stripe.sqlite"), [
    "CREATE TABLE customers(user_id TEXT NOT NULL,livemode INTEGER NOT NULL,customer_id TEXT NOT NULL,PRIMARY KEY(user_id,livemode));",
  ]);
  host.cleanup(() => db.close());
  const lookup = (userId: string) =>
    db
      .prepare(
        "SELECT customer_id FROM customers WHERE user_id=? AND livemode=?",
      )
      .get(userId, Number(host.config().livemode === true)) as
      { customer_id: string } | undefined;
  async function customer(userId: string, signal: AbortSignal) {
    const saved = lookup(userId);
    if (saved) return saved.customer_id;
    const mode = Number(host.config().livemode === true);
    const result = await api(
      "customers",
      new URLSearchParams({ "metadata[pluhub_user_id]": userId }),
      signal,
      `customer:${mode}:${userId}`,
    );
    db.prepare(
      "INSERT INTO customers VALUES(?,?,?) ON CONFLICT(user_id,livemode) DO NOTHING",
    ).run(userId, mode, result.id);
    return lookup(userId)!.customer_id;
  }
  async function portal(
    userId: string,
    returnUrl: string,
    signal: AbortSignal,
    subscriptions: { id: string; orderId: string }[] = [],
  ) {
    if (!host.config().portalEnabled)
      throw new HostError(
        "portal_disabled",
        "Stripe customer portal is disabled",
        409,
      );
    let saved = lookup(userId);
    // Older checkouts created Stripe customers before the local customer index existed.
    // Commerce supplies only subscriptions owned by this authenticated user.
    if (!saved)
      for (const candidate of subscriptions) {
        const sub = await api(
          "subscriptions/" + encodeURIComponent(candidate.id),
          undefined,
          signal,
        );
        const customerId =
          typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
        if (
          sub.metadata?.orderId !== candidate.orderId ||
          sub.livemode !== (host.config().livemode === true) ||
          !customerId
        )
          continue;
        db.prepare(
          "INSERT INTO customers VALUES(?,?,?) ON CONFLICT(user_id,livemode) DO NOTHING",
        ).run(userId, Number(host.config().livemode === true), customerId);
        saved = lookup(userId);
        break;
      }
    if (!saved)
      throw new HostError(
        "not_found",
        "No Stripe customer for this account",
        404,
      );
    const form = new URLSearchParams({
      customer: saved.customer_id,
      return_url: returnUrl,
    });
    if (host.config().portalConfiguration)
      form.set("configuration", String(host.config().portalConfiguration));
    const result = await api("billing_portal/sessions", form, signal);
    return { url: result.url };
  }
  return { customer, portal };
}
