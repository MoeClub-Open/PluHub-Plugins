import type { AIPlan } from "@pluhub/contracts/ai";

export type ConsumptionSource = "platform" | "byoapi" | "byosub";

/** Classify the resolved, owner-checked route, never a client-supplied flag. */
export function consumptionSource(plan: AIPlan): ConsumptionSource {
  if (!plan.credentialId) return "platform";
  return plan.upstream.subscriptionAccountIds?.length ? "byosub" : "byoapi";
}
