import { switchFallback } from "../../lib/ai/fallback.js";
import { HostError, json, readObject, requiredString, type Host } from "@pluhub/sdk";
import type { AIPlan, AIRequest, Upstream } from "@pluhub/contracts/ai";
import { channelScope } from "../../lib/ai/channel-scope.js";
import { requestJev, type JevRequest, type JevResult } from "../../lib/ai/jev.js";
import { upstreamKey } from "../../lib/ai/upstream-key.js";
import { generationRejected, prepareBeforeGeneration } from "../../lib/ai/rejection.js";
import { beginObservation, observation, planObservation } from "../../lib/ai/telemetry.js";
import { responseModel } from "../../lib/ai/response-model.js";
import { capturePricingContext } from "../../lib/commerce/expression.js";

function inputValue(input: any): JevRequest {
  const model = requiredString(input.model, "model");
  if (typeof input.state !== "string" && (!input.state || typeof input.state !== "object"))
    throw new HostError("invalid_request", "Invalid Jev state");
  const questions = input.questions;
  if (!questions || typeof questions !== "object" || Array.isArray(questions) || !Object.keys(questions).length)
    throw new HostError("invalid_request", "Jev questions are required");
  for (const question of Object.values(questions) as any[]) {
    if (!question || typeof question !== "object" || !["choice", "score", "noul", "box"].includes(question.type) || question.instructions === undefined ||
      (question.type === "choice" && (!question.criteria || typeof question.criteria !== "object" || Array.isArray(question.criteria) || !Object.keys(question.criteria).length)) ||
      (question.type === "score" && !Array.isArray(question.criteria)))
      throw new HostError("invalid_request", "Invalid Jev question");
  }
  if (input.assets !== undefined && (!input.assets || typeof input.assets !== "object" || Array.isArray(input.assets)))
    throw new HostError("invalid_request", "Invalid Jev assets");
  return { model, state: input.state, questions, ...(input.assets ? { assets: input.assets } : {}) };
}

/** System One is exposed only to authenticated workflow child requests. */
export function installJevIngress(host: Host) {
  host.provide("ai.upstream.systemone@1", async (input: { request?: JevRequest; upstream: Upstream }, signal): Promise<JevResult> => {
    if (!input.request || !Object.hasOwn(input.request, "questions") || input.upstream.protocol !== "systemone")
      throw new HostError("operation_not_supported", "System One requires a Jev workflow request", 400);
    const upstream = input.upstream;
    const key = upstream.credentialId || upstream.keyRef
      ? await prepareBeforeGeneration(() => upstreamKey(host, upstream, signal))
      : undefined;
    return requestJev(host, {
      baseUrl: prepareBeforeGeneration(() => requiredString(upstream.baseUrl, "upstream URL", 2048)),
      publicOnly: upstream.publicOnly,
    }, input.request, signal, key);
  });
  host.route({
    internal: true, childCallers: [host.id],
    method: "POST",
    path: "/internal/workflow/jev",
    access: "authenticated",
    prepare: async (request, ctx) => {
      if (!ctx.parent) throw new HostError("not_found", "Not found", 404);
      beginObservation(ctx, "systemone");
      const input = inputValue(await readObject(request, 16 * 1024 * 1024));
      const allowed = ctx.principal?.attributes?.models as string[] | undefined;
      const delegated = ctx.state.get("internal.delegatedModel") === input.model;
      if (!delegated && allowed?.length && !allowed.includes(input.model))
        throw new HostError("model_forbidden", "API key cannot access this model", 403);
      const normalized: AIRequest = {
        model: input.model,
        messages: [{ role: "user", text: JSON.stringify({ state: input.state, questions: input.questions, assets: input.assets }) }],
        tools: [],
        stream: false,
      };
      ctx.state.set("jev.request", input);
      ctx.state.set("ai.request", normalized);
      if (delegated) ctx.state.set("auth.preflight", input.model);
      else if (host.hasCapability("auth.admit@1")) {
        await host.call("auth.admit@1", { model: input.model, principal: ctx.principal }, ctx.signal);
        ctx.state.set("auth.preflight", input.model);
      }
      const state = observation(ctx)!;
      state.model = input.model;
      state.stream = false;
      await host.call("ai.request-limits@1", { action: "preflight", principal: ctx.principal, context: ctx }, ctx.signal);
      const plan = await host.call<AIPlan>("ai.routing@2", {
        model: input.model,
        routeKind: "systemone",
        ingressProtocol: "openai-chat",
        request: normalized,
        features: ["text", "usage"],
        principalId: ctx.principal?.id,
        // Never retain the evaluation state or questions in pricing snapshots.
        pricingContext: capturePricingContext({ model: input.model }, request.headers, state.startedAt),
        ...channelScope(ctx.principal, request.headers.get("x-pluhub-channel") ?? undefined, request.headers.get("x-pluhub-group") ?? undefined),
      }, ctx.signal);
      if (plan.kind !== "provider" || plan.upstream.protocol !== "systemone" || plan.capability !== "ai.upstream.systemone@1")
        throw new HostError("operation_not_supported", "Selected model is not a System One model", 400);
      ctx.state.set("ai.plan", plan);
      planObservation(ctx, normalized, plan);
    },
    handle: async (_request, ctx) => {
      const input = ctx.state.get("jev.request") as JevRequest;
      const plan = ctx.state.get("ai.plan") as AIPlan;
      const request = ctx.state.get("ai.request") as AIRequest;
      const state = observation(ctx)!;
      ctx.state.set("ai.executionStarted", true);
      for (;;) {
        try {
          const result = await host.call<JevResult>("ai.upstream.systemone@1", {
            request: { ...input, model: plan.model }, upstream: plan.upstream,
          }, ctx.signal);
          if (result.usage) state.usage = result.usage;
          if (plan.recordResponseModel)
            state.upstreamResponseModel = responseModel("openai-chat", result);
          state.finished = true;
          return json(result);
        } catch (error) {
          const rejected = generationRejected(error);
          ctx.state.set("ai.executionRejected", rejected);
          const usage = (error as { usage?: JevResult["usage"] })?.usage;
          if (usage) state.usage = usage;
          const failure = error as { code?: string; retryable?: boolean };
          if (!await switchFallback(host, ctx, request, plan, error, ctx.signal, (next) => {
            if (next.kind !== "provider" || next.upstream.protocol !== "systemone" || next.capability !== "ai.upstream.systemone@1")
              throw new HostError("operation_not_supported", "备用模型不是 System One 模型", 400);
          })) {
            state.errorCode = failure.code ?? "upstream_error";
            throw error;
          }
        }
      }
    },
  });
}
