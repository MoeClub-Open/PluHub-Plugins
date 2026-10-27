import { definePlugin, readObject, HostError } from "@pluhub/sdk";
import type { Protocol, AIRequest, AIPlan } from "@pluhub/contracts/ai";
import { decode, protocolError } from "./protocols.js";
import { clientSession } from "./session.js";
import { channelScope } from "./channel-scope.js";
import { capturePricingContext } from "../commerce/expression.js";
import { executeIngress } from "./ingress-response.js";
import {
  beginObservation,
  planObservation,
  observation,
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
          const decoded = decode(protocol, input, model);
          if (protocol === "gemini") decoded.stream = stream;
          decoded.sessionId = clientSession(
            request,
            input,
            decoded,
            ctx.principal,
          );
          const allowed = ctx.principal?.attributes?.models as
            string[] | undefined;
          const delegated = !!ctx.parent && ctx.state.get("internal.delegatedModel") === decoded.model;
          if (!delegated && allowed?.length && !allowed.includes(decoded.model))
            throw new HostError(
              "model_forbidden",
              "API key cannot access this model",
              403,
            );
          ctx.state.set("ai.request", decoded);
          if (request.headers.has("x-pluhub-credential"))
            throw new HostError("unsupported_credential", "平台渠道凭证已移除");
          const channelHeader =
            request.headers.get("x-pluhub-channel") ?? undefined;
          const channels = channelScope(
            ctx.principal,
            channelHeader,
            request.headers.get("x-pluhub-group") ?? undefined,
          );
          if (!delegated && host.hasCapability("auth.admit@1")) {
            await host.call(
              "auth.admit@1",
              { model: decoded.model, principal: ctx.principal },
              ctx.signal,
            );
            ctx.state.set("auth.preflight", decoded.model);
          }
          if (delegated) ctx.state.set("auth.preflight", decoded.model);
          observation(ctx)!.model = decoded.model;
          observation(ctx)!.stream = decoded.stream;
          await host.call(
            "ai.request-limits@1",
            { action: "preflight", principal: ctx.principal, context: ctx },
            ctx.signal,
          );
          ctx.state.set(
            "ai.plan",
            await host.call<AIPlan>(
              "ai.routing@2",
              {
                model: decoded.model,
                ingressProtocol: protocol,
                request: decoded,
                features: [
                  "text",
                  "usage",
                  ...(decoded.tools.length || decoded.webSearch
                    ? ["tools"]
                    : []),
                  ...(decoded.stream ? ["stream"] : []),
                ],
                principalId: ctx.principal?.id,
                pricingContext: capturePricingContext(
                  input,
                  request.headers,
                  observation(ctx)!.startedAt,
                ),
                ...channels,
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
          if (plan.workflowDeferred) {
            if (!host.hasCapability("ai.workflow-execution@1"))
              throw new HostError("workflow_unavailable", "流程执行能力不可用", 503);
            ctx.state.set("workflow.ready", true);
            return host.call<Response>(
              "ai.workflow-execution@1",
              undefined,
              ctx.signal,
            );
          }
          return executeIngress(host, ctx, decoded, plan, protocol);
        },
      });
    },
  });
}
