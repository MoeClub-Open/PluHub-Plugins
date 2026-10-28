import { HostError, type Host, type RequestContext } from "@pluhub/sdk";
import type { AIEvent, AIPlan, AIRequest, Protocol } from "@pluhub/contracts/ai";
import { generationRejected } from "./rejection.js";
import { switchFallback } from "./fallback.js";
import { observation } from "./telemetry.js";
import { decodeResult, resultEvents } from "./protocols.js";
import { upstreamEvents } from "./streams.js";
import { decodeUsage } from "./usage.js";

/** Convert a metered fallback workflow response back to normalized events. */
async function* workflowResponseEvents(
  response: Response,
  protocol: Protocol,
  model: string,
  streaming: boolean,
  ctx: RequestContext,
): AsyncGenerator<AIEvent> {
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as any;
    throw new HostError(body?.error?.code ?? "workflow_child_failed", body?.error?.message ?? "备用流程执行失败", response.status);
  }
  if (streaming) {
    if (!response.body) throw new HostError("upstream_protocol", "备用流程未返回响应流", 502);
    for await (const event of upstreamEvents(protocol, response.body)) {
      if (event.type === "upstream-model") continue;
      if (event.type === "usage") ctx.state.set("workflow.forwardUsage", true);
      yield event;
    }
  } else {
    const body = await response.json();
    const usagePresent = !!decodeUsage(protocol, protocol === "gemini" ? (body as any)?.usageMetadata : (body as any)?.usage);
    for await (const event of resultEvents(decodeResult(protocol, body, model))) {
      if (event.type === "usage") {
        if (!usagePresent) continue;
        ctx.state.set("workflow.forwardUsage", true);
      }
      yield event;
    }
  }
}

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
        if (!await switchFallback(host, ctx, request, plan, error, signal)) throw error;
        if (plan.workflowDeferred) {
          if (!host.hasCapability("ai.workflow-execution@1"))
            throw new HostError("workflow_unavailable", "备用流程执行能力不可用", 503);
          const protocol = observation(ctx)?.protocol as Protocol | undefined;
          if (!protocol || !["openai-chat", "openai-responses", "anthropic", "gemini"].includes(protocol))
            throw new HostError("operation_not_supported", "备用流程仅支持对话请求", 400);
          ctx.state.set("ai.executionRejected", false);
          ctx.state.set("workflow.ready", true);
          const response = await host.call<Response>("ai.workflow-execution@1", undefined, signal);
          yield* workflowResponseEvents(response, protocol, plan.responseModel ?? request.model, request.stream, ctx);
          return;
        }
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
