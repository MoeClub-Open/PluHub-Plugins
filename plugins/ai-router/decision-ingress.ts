import { routingContext } from "./request-context.js";
import {
  HostError,
  json,
  readObject,
  requiredString,
  type Host,
} from "@pluhub/sdk";
import type { AIPlan, AIRequest, Upstream, Usage } from "@pluhub/contracts/ai";
import type { DecisionBackend } from "@pluhub/contracts/routing";
import { channelScope } from "../../lib/ai/channel-scope.js";
import {
  decisionBody,
  parseDecision,
  type DifficultyDecision,
} from "../../lib/ai/decision-protocol.js";
import { requestLegacyDecision } from "../../lib/ai/legacy-decision.js";
import {
  beginObservation,
  observation,
  planObservation,
} from "../../lib/ai/telemetry.js";
import { generationRejected } from "../../lib/ai/rejection.js";
import { switchFallback } from "../../lib/ai/fallback.js";
import { capturePricingContext } from "../../lib/commerce/expression.js";
import { getDecisionScope } from "./decision-scope.js";

type Kind = "luna" | "systemone" | "jev";
type DecisionInput = {
  kind: Kind;
  model: string;
  state: unknown;
  timeoutMs?: number;
};
type DecisionResult = {
  decision: DifficultyDecision;
  usage?: Usage;
  upstreamModel?: string;
};
const kinds: readonly string[] = ["luna", "systemone", "jev"];

/** Metered native decision requests are accessible only to an authorized workflow child. */
export function installDecisionIngress(host: Host) {
  for (const kind of ["luna", "jev"] as const)
    host.provide(
      `ai.upstream.${kind}@1`,
      async (
        input: { request: DecisionInput; upstream: Upstream },
        signal,
      ): Promise<DecisionResult> => {
        if (input.upstream.protocol !== kind || input.request?.kind !== kind)
          throw new HostError(
            "operation_not_supported",
            "决策渠道仅支持对应的决策请求",
            400,
          );
        return requestLegacyDecision(
          host,
          kind,
          input.upstream,
          decisionBody(kind, input.request.model, input.request.state),
          (body) => parseDecision(kind, body),
          signal,
          input.request.timeoutMs,
        );
      },
    );

  host.provide(
    "ai.workflow-decision@1",
    async (
      input: { profile: string; token?: string },
      signal,
    ): Promise<DifficultyDecision> => {
      const profile = requiredString(input.profile, "profile", 128);
      const scope = getDecisionScope(host, profile, input.token);
      const ctx = routingContext(host);
      const config = await host.call<DecisionBackend>(
        "ai.decision-profile@1",
        { profile },
        signal,
        "official.auto-router",
      );
      if (
        !kinds.includes(config.kind) ||
        !config.model ||
        config.baseUrl ||
        config.keyRef
      )
        throw new HostError(
          "decision_migration_required",
          "请先将决策服务配置为有价格的渠道模型",
          409,
        );
      if (
        config.channelId &&
        scope.allowedChannelIds?.length &&
        !scope.allowedChannelIds.includes(config.channelId)
      )
        throw new HostError(
          "channel_forbidden",
          "决策渠道不在密钥授权范围内",
          403,
        );
      const text = JSON.stringify({
        messages: scope.request.messages,
        tools: scope.request.tools,
      });
      const limit = config.maxInputChars ?? 16000;
      if (text.length > limit)
        return {
          difficulty: "standard",
          confidence: 0,
          source: config.kind,
          truncated: true,
        };
      await host.call(
        "ai.request-limits@1",
        {
          action: "early-admit",
          context: ctx,
          policies: scope.requestLimits,
          channelId: scope.channelId,
        },
        signal,
      );
      const headers = new Headers({ "content-type": "application/json" });
      if (config.channelId) headers.set("x-pluhub-channel", config.channelId);
      const response = await host.dispatchChild(
        new Request(new URL("/internal/workflow/decision", ctx.request.url), {
          method: "POST",
          headers,
          signal,
          body: JSON.stringify({
            kind: config.kind,
            model: config.model,
            state: { task: text, truncated: false },
            timeoutMs: config.timeoutMs,
          }),
        }),
        {
          nodeId: `decision:${profile.slice(0, 119)}`,
          delegatedModel: config.model,
        },
      );
      const body = (await response.json().catch(() => undefined)) as any;
      if (!response.ok)
        throw new HostError(
          body?.error?.code ?? "decision_unavailable",
          body?.error?.message ?? "决策请求失败",
          response.status,
        );
      if (!body || typeof body !== "object")
        throw new HostError(
          "invalid_decision",
          "Invalid decision response",
          502,
        );
      return body as DifficultyDecision;
    },
  );

  host.route({
    internal: true,
    childCallers: [host.id],
    method: "POST",
    path: "/internal/workflow/decision",
    access: "authenticated",
    prepare: async (request, ctx) => {
      if (!ctx.parent) throw new HostError("not_found", "Not found", 404);
      beginObservation(ctx, "decision");
      const raw = await readObject<DecisionInput>(request, 16 * 1024 * 1024);
      const model = requiredString(raw.model, "model");
      if (
        !kinds.includes(raw.kind) ||
        !raw.state ||
        typeof raw.state !== "object"
      )
        throw new HostError("invalid_request", "无效的决策请求", 400);
      const allowed = ctx.principal?.attributes?.models as string[] | undefined;
      const delegated = ctx.state.get("internal.delegatedModel") === model;
      if (!delegated && allowed?.length && !allowed.includes(model))
        throw new HostError(
          "model_forbidden",
          "API key cannot access this model",
          403,
        );
      const payload = decisionBody(raw.kind, model, raw.state);
      const normalized: AIRequest = {
        model,
        messages: [{ role: "user", text: JSON.stringify(payload) }],
        tools: [],
        stream: false,
      };
      ctx.state.set("decision.request", { ...raw, model });
      ctx.state.set("ai.request", normalized);
      if (delegated) ctx.state.set("auth.preflight", model);
      else if (host.hasCapability("auth.admit@1")) {
        await host.call(
          "auth.admit@1",
          { model, principal: ctx.principal },
          ctx.signal,
        );
        ctx.state.set("auth.preflight", model);
      }
      const state = observation(ctx)!;
      state.model = model;
      state.protocol = raw.kind;
      state.stream = false;
      await host.call(
        "ai.request-limits@1",
        { action: "preflight", principal: ctx.principal, context: ctx },
        ctx.signal,
      );
      const plan = await host.call<AIPlan>(
        "ai.routing@3",
        {
          model,
          routeKind: raw.kind,
          ingressProtocol: "openai-chat",
          request: normalized,
          features: ["text", "usage"],
          principalId: ctx.principal?.id,
          pricingContext: capturePricingContext(
            { model },
            request.headers,
            state.startedAt,
          ),
          ...channelScope(
            ctx.principal,
            request.headers.get("x-pluhub-channel") ?? undefined,
          ),
        },
        ctx.signal,
      );
      if (
        plan.kind !== "provider" ||
        plan.upstream.protocol !== raw.kind ||
        plan.capability !== `ai.upstream.${raw.kind}@1`
      )
        throw new HostError(
          "operation_not_supported",
          "决策模型协议不匹配",
          400,
        );
      if (!plan.pricing)
        throw new HostError(
          "decision_price_required",
          "请先配置决策模型价格",
          409,
        );
      ctx.state.set("ai.plan", plan);
      planObservation(ctx, normalized, plan);
    },
    handle: async (_request, ctx) => {
      const input = ctx.state.get("decision.request") as DecisionInput;
      const normalized = ctx.state.get("ai.request") as AIRequest;
      const plan = ctx.state.get("ai.plan") as AIPlan;
      const state = observation(ctx)!;
      ctx.state.set("ai.executionStarted", true);
      for (;;) {
        try {
          let result: DecisionResult;
          if (input.kind === "systemone") {
            const body = await host.call<any>(
              "ai.upstream.systemone@1",
              {
                request: decisionBody("systemone", plan.model, input.state),
                upstream: plan.upstream,
              },
              ctx.signal,
            );
            if (body.usage) state.usage = body.usage;
            result = {
              decision: parseDecision("systemone", body),
              usage: body.usage,
              upstreamModel: body.model,
            };
          } else {
            result = await host.call<DecisionResult>(
              `ai.upstream.${input.kind}@1`,
              {
                request: { ...input, model: plan.model },
                upstream: plan.upstream,
              },
              ctx.signal,
            );
          }
          if (result.usage) state.usage = result.usage;
          if (
            plan.recordResponseModel &&
            result.upstreamModel &&
            result.upstreamModel.length <= 256 &&
            result.upstreamModel.trim()
          )
            state.upstreamResponseModel = result.upstreamModel;
          state.finished = true;
          return json(result.decision);
        } catch (error) {
          const rejected = generationRejected(error);
          ctx.state.set("ai.executionRejected", rejected);
          const failure = error as {
            code?: string;
            retryable?: boolean;
            usage?: Usage;
          };
          if (failure.usage) state.usage = failure.usage;
          if (
            !(await switchFallback(
              host,
              ctx,
              normalized,
              plan,
              error,
              ctx.signal,
              (next) => {
                if (
                  next.kind !== "provider" ||
                  next.upstream.protocol !== input.kind ||
                  !next.pricing
                )
                  throw new HostError(
                    "decision_price_required",
                    "备用决策模型协议或价格无效",
                    409,
                  );
              },
            ))
          ) {
            state.errorCode = failure.code ?? "upstream_error";
            throw error;
          }
        }
      }
    },
  });
}
