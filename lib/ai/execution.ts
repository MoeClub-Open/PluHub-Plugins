import type { Host, RequestContext } from "@pluhub/sdk";
import type { AIEvent, AIPlan, AIRequest } from "@pluhub/contracts/ai";
import { generationRejected } from "./rejection.js";
import { observation, planObservation } from "./telemetry.js";

/** Only a definite refusal before the first normalized event may be replayed. */
export async function executeRequest(
  host: Host,
  ctx: RequestContext,
  request: AIRequest,
  plan: AIPlan,
  signal: AbortSignal,
): Promise<AsyncIterable<AIEvent>> {
  async function* run(): AsyncGenerator<AIEvent> {
    for (;;) {
      let delivered = false;
      let responseModel: string | undefined;
      try {
        ctx.state.set("ai.executionRejected", false);
        const events = await host.call<AsyncIterable<AIEvent>>(
          "ai.execution@1",
          { request, plan },
          signal,
        );
        for await (const event of events) {
          if (event.type === "upstream-model") {
            responseModel = event.model;
            if (delivered && plan.recordResponseModel && observation(ctx))
              observation(ctx)!.upstreamResponseModel = responseModel;
            continue;
          }
          delivered = true;
          if (responseModel && plan.recordResponseModel && observation(ctx))
            observation(ctx)!.upstreamResponseModel = responseModel;
          yield event;
        }
        return;
      } catch (error) {
        const rejected = !delivered && generationRejected(error);
        ctx.state.set("ai.executionRejected", rejected);
        signal.throwIfAborted();
        const failure = error as { code?: string; retryable?: boolean };
        if (
          !rejected ||
          !plan.fallback ||
          !(
            failure.retryable ||
            [
              "subscription_unavailable",
              "subscription_disabled",
              "credential_unavailable",
              "credentials_required",
            ].includes(failure.code ?? "")
          )
        )
          throw error;
        const next = await host.call<AIPlan>(
          "ai.routing@2",
          plan.fallback,
          signal,
        );
        const attempts = [
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
            ...(plan.outputPolicy.aggregateTps ||
            next.outputPolicy?.aggregateTps
              ? {
                  aggregateTps: Math.min(
                    plan.outputPolicy.aggregateTps ?? Infinity,
                    next.outputPolicy?.aggregateTps ?? Infinity,
                  ),
                }
              : {}),
          };
        const responseModel = plan.responseModel;
        for (const key of Object.keys(plan))
          delete (plan as unknown as Record<string, unknown>)[key];
        Object.assign(plan, next, { responseModel, attempts });
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
          await host.call(
            "billing.admit@1",
            { context: ctx, retry: true },
            signal,
          );
      }
    }
  }
  const stream = run();
  const first = await stream.next();
  return (async function* () {
    try {
      if (!first.done) yield first.value;
      yield* stream;
    } finally {
      await stream.return(undefined);
    }
  })();
}
