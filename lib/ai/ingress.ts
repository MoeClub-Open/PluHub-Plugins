import { definePlugin, readObject, json, HostError } from "@pluhub/sdk";
import type {
  Protocol,
  AIRequest,
  AIEvent,
  AIPlan,
} from "@pluhub/contracts/ai";
import { decode, collect, encodeResult, protocolError } from "./protocols.js";
import { encodeStream } from "./streams.js";
import { clientSession } from "./session.js";
import {
  beginObservation,
  planObservation,
  observation,
  observeEvents,
} from "./telemetry.js";
export function createIngress(protocol: Protocol) {
  return definePlugin({
    setup(host) {
      host.provide("ai.ingress." + protocol + "@1", () => ({
        protocol,
        features: ["text", "tools", "stream", "usage"],
      }));
      const path =
        protocol === "openai-chat"
          ? "/v1/chat/completions"
          : protocol === "openai-responses"
            ? "/v1/responses"
            : protocol === "anthropic"
              ? "/v1/messages"
              : "/v1beta/models/*";
      host.route({
        method: "POST",
        path,
        access: "authenticated",
        error: (error) => protocolError(protocol, error),
        prepare: async (request, ctx) => {
          beginObservation(ctx, protocol);
          const url = new URL(request.url);
          let model: string | undefined;
          let stream = false;
          if (protocol === "gemini") {
            const match =
              /^\/v1beta\/models\/(.+):(generateContent|streamGenerateContent)$/.exec(
                url.pathname,
              );
            if (!match)
              throw new HostError("not_found", "Unknown Gemini method", 404);
            model = decodeURIComponent(match[1]!);
            stream = match[2] === "streamGenerateContent";
          }
          const input = await readObject(request, 16 * 1024 * 1024);
          const decoded = host.hasCapability("ai.converter@1")
            ? await host.call<AIRequest>(
                "ai.converter@1",
                { action: "decode", protocol, input, model },
                ctx.signal,
              )
            : decode(protocol, input, model);
          if (protocol === "gemini") decoded.stream = stream;
          decoded.sessionId = clientSession(
            request,
            input,
            decoded,
            ctx.principal,
          );
          const allowed = ctx.principal?.attributes?.models as
            string[] | undefined;
          if (allowed?.length && !allowed.includes(decoded.model))
            throw new HostError(
              "model_forbidden",
              "API key cannot access this model",
              403,
            );
          ctx.state.set("ai.request", decoded);
          const policy = ctx.principal?.attributes;
          if (request.headers.has("x-pluhub-credential"))
            throw new HostError("unsupported_credential", "平台渠道凭证已移除");
          const boundChannel = policy?.channelId as string | undefined;
          const channelHeader =
            request.headers.get("x-pluhub-channel") ?? undefined;
          if (boundChannel && channelHeader && channelHeader !== boundChannel)
            throw new HostError(
              "channel_forbidden",
              "请求不能覆盖 API Key 的渠道绑定",
              403,
            );
          if (host.hasCapability("auth.admit@1")) {
            await host.call(
              "auth.admit@1",
              { model: decoded.model, principal: ctx.principal },
              ctx.signal,
            );
            ctx.state.set("auth.preflight", decoded.model);
          }
          observation(ctx)!.model = decoded.model;
          observation(ctx)!.stream = decoded.stream;
          ctx.state.set(
            "ai.plan",
            await host.call<AIPlan>(
              "ai.routing@1",
              {
                model: decoded.model,
                ingressProtocol: protocol,
                request: decoded,
                features: [
                  "text",
                  "usage",
                  ...(decoded.tools.length ? ["tools"] : []),
                  ...(decoded.stream ? ["stream"] : []),
                ],
                principalId: ctx.principal?.id,
                channelId: boundChannel ?? channelHeader,
              },
              ctx.signal,
            ),
          );
          const plan = ctx.state.get("ai.plan") as AIPlan;
          if (plan.preparedRequest)
            ctx.state.set("ai.request", {
              ...plan.preparedRequest,
              model: decoded.model,
            });
          planObservation(ctx, ctx.state.get("ai.request") as AIRequest, plan);
        },
        handle: async (_request, ctx) => {
          const decoded = ctx.state.get("ai.request") as AIRequest;
          const plan = ctx.state.get("ai.plan") as AIPlan;
          const responseModel = plan.responseModel ?? decoded.model;
          ctx.state.set("ai.executionStarted", true);
          const execution = new AbortController();
          const executionSignal = AbortSignal.any([
            ctx.signal,
            execution.signal,
          ]);
          const events = await host.call<AsyncIterable<AIEvent>>(
            "ai.execution@1",
            { plan, request: decoded },
            executionSignal,
          );
          if (!decoded.stream) {
            const collected = await collect(
              observeEvents(events, ctx),
              responseModel,
            );
            const result = host.hasCapability("ai.converter@1")
              ? await host.call<Record<string, any>>(
                  "ai.converter@1",
                  { action: "encodeResult", protocol, input: collected },
                  ctx.signal,
                )
              : encodeResult(protocol, collected);
            if (!observation(ctx)?.usage) {
              delete result.usage;
              delete result.usageMetadata;
            }
            const response = json(result);
            if (plan.redirection?.mode === "explicit")
              response.headers.set("x-pluhub-model", responseModel);
            return response;
          }
          const observed = observeEvents(events, ctx);
          const streamOptions = {
            onError: (error: unknown) => {
              observation(ctx)!.errorCode =
                typeof (error as any)?.code === "string"
                  ? (error as any).code
                  : "stream_error";
            },
            onCancel: (reason: unknown) => execution.abort(reason),
          };
          const body = host.hasCapability("ai.converter@1")
            ? await host.call<ReadableStream<Uint8Array>>(
                "ai.converter@1",
                {
                  action: "encodeStream",
                  protocol,
                  input: observed,
                  model: responseModel,
                  streamOptions,
                },
                ctx.signal,
              )
            : encodeStream(
                protocol,
                observed,
                responseModel,
                ctx.signal,
                streamOptions,
              );
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
        },
      });
    },
  });
}
