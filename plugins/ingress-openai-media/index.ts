import { definePlugin, HostError, json } from "@pluhub/sdk";
import type { AIPlan, AIRequest } from "@pluhub/contracts/ai";
import { mediaKinds, mediaPaths, readMedia } from "../../lib/ai/media.js";
import { channelScope } from "../../lib/ai/channel-scope.js";
import { capturePricingContext } from "../../lib/commerce/expression.js";
import { executeRequest } from "../../lib/ai/execution.js";
import {
  beginObservation,
  observation,
  planObservation,
  observeEvents,
} from "../../lib/ai/telemetry.js";
import { protocolError } from "../../lib/ai/protocols.js";

export default definePlugin({
  setup(host) {
    host.provide("ai.ingress.openai-media@1", () => ({
      operations: mediaKinds,
    }));
    for (const kind of mediaKinds)
      host.route({
        method: "POST",
        path: mediaPaths[kind],
        access: "authenticated",
        error: (error) => protocolError("openai-chat", error),
        prepare: async (request, ctx) => {
          beginObservation(ctx, kind);
          const decoded = await readMedia(request, kind);
          ctx.state.set("ai.request", decoded);
          Object.assign(observation(ctx)!, {
            model: decoded.model,
            stream: decoded.stream,
          });
          const allowed = ctx.principal?.attributes?.models as
            string[] | undefined;
          if (allowed?.length && !allowed.includes(decoded.model))
            throw new HostError(
              "model_forbidden",
              "API key cannot access this model",
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
          await host.call(
            "ai.request-limits@1",
            { action: "preflight", principal: ctx.principal },
            ctx.signal,
          );
          const plan = await host.call<AIPlan>(
            "ai.routing@2",
            {
              model: decoded.model,
              request: decoded,
              ingressProtocol: "openai-chat",
              features: ["usage"],
              principalId: ctx.principal?.id,
              ...channelScope(
                ctx.principal,
                request.headers.get("x-pluhub-channel") ?? undefined,
                request.headers.get("x-pluhub-group") ?? undefined,
              ),
              pricingContext: capturePricingContext(
                decoded.operation!.input,
                request.headers,
                observation(ctx)!.startedAt,
              ),
            },
            ctx.signal,
          );
          ctx.state.set("ai.plan", plan);
          planObservation(ctx, decoded, plan);
        },
        handle: async (_request, ctx) => {
          const request = ctx.state.get("ai.request") as AIRequest;
          const plan = ctx.state.get("ai.plan") as AIPlan;
          const controller = new AbortController();
          const signal = AbortSignal.any([ctx.signal, controller.signal]);
          ctx.state.set("ai.executionStarted", true);
          const events = await executeRequest(host, ctx, request, plan, signal);
          const iterator = observeEvents(events, ctx)[Symbol.asyncIterator]();
          const nextMedia = async () => {
            for (;;) {
              const item = await iterator.next();
              if (item.done) return;
              if (item.value.type === "media") return item.value;
            }
          };
          let first: Awaited<ReturnType<typeof nextMedia>>;
          try {
            first = await nextMedia();
          } catch (error) {
            controller.abort(error);
            await iterator.return?.();
            throw error;
          }
          if (!first)
            throw new HostError(
              "upstream_protocol",
              "Empty media response",
              502,
            );
          if (!(first.body instanceof Uint8Array)) {
            try {
              if (await nextMedia())
                throw new HostError(
                  "upstream_protocol",
                  "Unexpected extra media response",
                  502,
                );
              const response = json({
                ...first.body,
                ...(Object.hasOwn(first.body, "model")
                  ? { model: plan.responseModel ?? request.model }
                  : {}),
              });
              response.headers.set("cache-control", "no-store");
              if (plan.redirection?.mode === "explicit")
                response.headers.set("x-pluhub-model", plan.responseModel!);
              return response;
            } finally {
              await iterator.return?.();
            }
          }
          let pending: Uint8Array | undefined = first.body;
          let closed = false;
          const stop = async (reason?: unknown) => {
            controller.abort(reason);
            await iterator.return?.();
          };
          const body = new ReadableStream<Uint8Array>({
            async pull(out) {
              try {
                signal.throwIfAborted();
                if (pending) {
                  out.enqueue(pending);
                  pending = undefined;
                  return;
                }
                const event = await nextMedia();
                if (closed) return;
                if (!event) {
                  closed = true;
                  out.close();
                } else if (event.body instanceof Uint8Array)
                  out.enqueue(event.body);
                else
                  throw new HostError(
                    "upstream_protocol",
                    "Unexpected media format",
                    502,
                  );
              } catch (error) {
                if (!closed) {
                  closed = true;
                  out.error(error);
                }
                await stop(error);
              }
            },
            async cancel(reason) {
              closed = true;
              await stop(reason);
            },
          });
          return new Response(body, {
            headers: {
              "content-type": first.contentType,
              "cache-control": "no-store",
              "x-accel-buffering": "no",
              ...(plan.redirection?.mode === "explicit"
                ? { "x-pluhub-model": plan.responseModel! }
                : {}),
            },
          });
        },
      });
  },
});
