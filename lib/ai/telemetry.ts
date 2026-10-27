import { HostError, type RequestContext } from "@pluhub/sdk";
import type { AIEvent, AIPlan, AIRequest } from "@pluhub/contracts/ai";
import type { Usage, RequestPricing } from "@pluhub/contracts/ai";
import type { OutputBudget } from "./output-budget.js";
import {
  consumptionSource,
  type ConsumptionSource,
} from "../commerce/consumption.js";
export interface AIObservation {
  startedAt: number;
  protocol: string;
  model?: string;
  upstreamResponseModel?: string;
  upstream?: string;
  stream?: boolean;
  firstTokenMs?: number;
  generationMs?: number;
  usage?: Usage;
  pricing?: RequestPricing;
  consumptionSource?: ConsumptionSource;
  finished?: boolean;
  errorCode?: string;
  routing?: {
    targetModel?: string;
    effort?: string;
    logicalUpstream?: string;
    decision?: AIPlan["decision"];
    attempts?: AIPlan["attempts"];
    redirection?: AIPlan["redirection"];
    workflows?: AIPlan["workflows"];
    outputBudget?: OutputBudget;
    webSearchCalls?: number;
  };
}
export function observation(ctx: RequestContext): AIObservation | undefined {
  return ctx.state.get("ai.observation") as AIObservation | undefined;
}
export function beginObservation(ctx: RequestContext, protocol: string) {
  if (observation(ctx)) return;
  ctx.state.set("ai.observation", {
    startedAt: Date.now(),
    protocol,
  } satisfies AIObservation);
}
export function planObservation(
  ctx: RequestContext,
  request: AIRequest,
  plan: AIPlan,
) {
  const source = consumptionSource(plan);
  // Personal routes are free to the wallet; observation retains their upstream cost.
  const pricing =
    source !== "platform" && plan.pricing
      ? { ...plan.pricing, multiplier: 1 }
      : plan.pricing;
  Object.assign(observation(ctx)!, {
    model: request.model,
    stream: request.stream,
    upstream: plan.upstreamId,
    pricing,
    consumptionSource: source,
    ...(plan.decision || plan.reasoning || plan.redirection || plan.workflows
      ? {
          routing: {
            targetModel: plan.model,
            effort: plan.reasoning?.effort,
            logicalUpstream: plan.logicalUpstreamId,
            decision: plan.decision,
            attempts: plan.attempts,
            redirection: plan.redirection,
            workflows: plan.workflows,
          },
        }
      : {}),
  });
}
export async function* observeEvents(
  events: AsyncIterable<AIEvent>,
  ctx: RequestContext,
) {
  const state = observation(ctx)!;
  let contentEvents = 0;
  const searchCalls = new Set<string>();
  let firstOutputMs: number | undefined;
  try {
    for await (const event of events) {
      if (
        event.type === "text" ||
        event.type === "tool" ||
        event.type === "media" ||
        event.type === "reasoning" ||
        event.type === "refusal"
      ) {
        const elapsed = Date.now() - state.startedAt;
        state.firstTokenMs ??= elapsed;
        if (event.type !== "reasoning") {
          firstOutputMs ??= elapsed;
          if (state.stream && ++contentEvents > 1 && elapsed > firstOutputMs)
            state.generationMs = elapsed - firstOutputMs;
        }
      }
      if (
        event.type === "usage" &&
        !ctx.state.get("workflow.forwardUsage") &&
        [event.usage.input, event.usage.output].every(
          (n) => Number.isSafeInteger(n) && n >= 0,
        )
      ) {
        state.usage = {
          ...event.usage,
          ...(searchCalls.size ? { webSearch: searchCalls.size } : {}),
        };
        const budget = state.routing?.outputBudget;
        if (
          budget?.mode === "bounded" &&
          budget.limit !== undefined &&
          event.usage.output > budget.limit
        )
          throw new HostError(
            "upstream_budget_exceeded",
            "Upstream usage exceeded the output token limit",
            502,
          );
      }
      if (
        event.type === "search" &&
        (event.call.status === "completed" || event.phase === "completed")
      ) {
        searchCalls.add(event.call.id);
        state.routing = { ...state.routing, webSearchCalls: searchCalls.size };
        if (state.usage) state.usage.webSearch = searchCalls.size;
      }
      if (event.type === "finish") state.finished = true;
      yield event;
    }
  } catch (error) {
    state.errorCode =
      typeof (error as any)?.code === "string"
        ? (error as any).code
        : "upstream_error";
    throw error;
  } finally {
    if (!state.finished && !state.errorCode)
      state.errorCode = "upstream_incomplete";
  }
}
