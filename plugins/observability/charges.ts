import type { Host } from "@pluhub/sdk";
import type { RequestCharge } from "@pluhub/contracts/commerce";

export async function attachCharges(
  host: Host,
  rows: Record<string, any>[],
  signal: AbortSignal,
): Promise<Record<string, any>[]> {
  const charges = new Map<string, RequestCharge>();
  const available = host.hasCapability("billing.request-charges@1");
  let failed = false;
  if (available) {
    try {
      for (let index = 0; index < rows.length; index += 500) {
        const requests = rows
          .slice(index, index + 500)
          .filter((row) => row.user_id)
          .map((row) => ({ id: row.id, userId: row.user_id }));
        if (!requests.length) continue;
        for (const charge of await host.call<RequestCharge[]>(
          "billing.request-charges@1",
          { requests },
          signal,
        ))
          charges.set(charge.requestId, charge);
      }
    } catch (error) {
      signal.throwIfAborted();
      failed = true;
      host.log("warn", "Request charges are temporarily unavailable");
    }
  }
  return rows.map((row) => {
    const charge = charges.get(row.id);
    const exempt = ["personal", "disabled"].includes(row.billing_mode);
    return {
      ...row,
      charged_micro_usd: charge?.charged ?? (exempt ? 0 : null),
      held_micro_usd: charge?.held ?? (exempt ? 0 : null),
      billing_status:
        charge?.status ??
        (exempt
          ? row.billing_mode
          : !available || failed
            ? "unavailable"
            : "unknown"),
      billing_receipt: charge?.receipt,
    };
  });
}
