import { json, type Host, type RequestContext } from "@pluhub/sdk";
import type { AIPlan, AIRequest, Protocol } from "@pluhub/contracts/ai";
import { executeRequest } from "./execution.js";
import { collect, encodeResult } from "./protocols.js";
import { encodeStream } from "./streams.js";
import { observation, observeEvents } from "./telemetry.js";

/** Execute one planned provider call and encode it for the selected ingress. */
export async function executeIngress(
  host: Host,
  ctx: RequestContext,
  request: AIRequest,
  plan: AIPlan,
  protocol: Protocol,
) {
  const responseModel = plan.responseModel ?? request.model;
  ctx.state.set("ai.executionStarted", true);
  const execution = new AbortController();
  const signal = AbortSignal.any([ctx.signal, execution.signal]);
  const events = await executeRequest(host, ctx, request, plan, signal);
  if (!request.stream) {
    const collected = await collect(observeEvents(events, ctx), responseModel);
    const result = encodeResult(protocol, collected);
    if (!observation(ctx)?.usage && !ctx.state.get("workflow.forwardUsage")) {
      delete result.usage;
      delete result.usageMetadata;
    }
    const response = json(result);
    if (plan.redirection?.mode === "explicit")
      response.headers.set("x-pluhub-model", responseModel);
    return response;
  }
  const body = encodeStream(protocol, observeEvents(events, ctx), responseModel, ctx.signal, {
    onError: (error: unknown) => {
      observation(ctx)!.errorCode =
        typeof (error as { code?: unknown })?.code === "string"
          ? (error as { code: string }).code
          : "stream_error";
    },
    onCancel: (reason: unknown) => execution.abort(reason),
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
      ...(plan.redirection?.mode === "explicit"
        ? { "x-pluhub-model": responseModel }
        : {}),
    },
  });
}
