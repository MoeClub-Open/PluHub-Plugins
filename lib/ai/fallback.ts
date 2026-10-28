import type { Host, RequestContext } from "@pluhub/sdk";
import type { AIPlan, AIRequest } from "@pluhub/contracts/ai";
import { planObservation } from "./telemetry.js";

const recoverable = new Set([
  "subscription_unavailable",
  "subscription_disabled",
  "credential_unavailable",
  "credentials_required",
]);

/** A caller must establish a definite rejection before invoking this transition. */
export async function switchFallback(
  host: Host,
  ctx: RequestContext,
  request: AIRequest,
  plan: AIPlan,
  error: unknown,
  signal: AbortSignal,
  validate?: (next: AIPlan) => void,
): Promise<boolean> {
  signal.throwIfAborted();
  const failure = error as { code?: string; retryable?: boolean };
  if (
    !ctx.state.get("ai.executionRejected") ||
    !plan.fallback ||
    !(failure.retryable || recoverable.has(failure.code ?? ""))
  )
    return false;
  const next = await host.call<AIPlan>("ai.routing@2", plan.fallback, signal);
  validate?.(next);
  next.attempts = [
    ...(plan.attempts ?? []),
    {
      channel: plan.upstreamId,
      model: plan.model,
      error: failure.code ?? "upstream_rejected",
    },
  ];
  next.requestLimits = [
    ...(plan.requestLimits ?? []),
    ...(next.requestLimits ?? []),
  ];
  if (plan.outputPolicy)
    next.outputPolicy = {
      ...plan.outputPolicy,
      ...next.outputPolicy,
      ...(plan.outputPolicy.tps || next.outputPolicy?.tps
        ? {
            tps: Math.min(
              plan.outputPolicy.tps ?? Infinity,
              next.outputPolicy?.tps ?? Infinity,
            ),
          }
        : {}),
      ...(plan.outputPolicy.aggregateTps || next.outputPolicy?.aggregateTps
        ? {
            aggregateTps: Math.min(
              plan.outputPolicy.aggregateTps ?? Infinity,
              next.outputPolicy?.aggregateTps ?? Infinity,
            ),
          }
        : {}),
    };
  const responseModel = plan.responseModel;
  // Existing response and finalization handlers retain this plan reference.
  for (const key of Object.keys(plan))
    delete (plan as unknown as Record<string, unknown>)[key];
  Object.assign(plan, next, { responseModel });
  const prepared = {
    ...(plan.preparedRequest ?? request),
    model: request.model,
  };
  ctx.state.set("ai.plan", plan);
  ctx.state.set("ai.request", prepared);
  planObservation(ctx, prepared, plan);
  await host.call(
    "ai.request-limits@1",
    { action: "admit", context: ctx, retry: true },
    signal,
  );
  if (host.hasCapability("billing.admit@1"))
    await host.call("billing.admit@1", { context: ctx, retry: true }, signal);
  ctx.state.set("ai.executionRejected", false);
  return true;
}
