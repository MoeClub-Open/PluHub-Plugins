import {
  definePlugin,
  HostError,
  json,
  readObject,
  requiredString,
} from "@pluhub/sdk";
import type {
  AIPlan,
  AIRequest,
  AIEvent,
  ModelRoute,
  ReasoningEffort,
} from "@pluhub/contracts/ai";
import type {
  RoutingProfile,
  RoutingCandidate,
  AutoRoutingInput,
} from "@pluhub/contracts/routing";
import { decide, type DifficultyDecision } from "./decisions.js";
import { efforts, encodeReasoning } from "../../lib/ai/reasoning.js";
import { priceUsage } from "../../lib/commerce/pricing.js";
import {
  bindPricingContext,
  capturePricingContext,
} from "../../lib/commerce/expression.js";
interface Eligible {
  candidate: RoutingCandidate;
  plan: AIPlan;
  route: ModelRoute;
  allowed: ReasoningEffort[];
}
export default definePlugin({
  setup(host) {
    const profiles = () =>
      (host.config().profiles ?? {}) as Record<string, RoutingProfile>;
    let active = 0;
    const windows = new Map<string, { minute: number; count: number }>();
    const sweep = setInterval(() => {
      for (const [k, v] of windows)
        if (v.minute < Math.floor(Date.now() / 60000) - 1) windows.delete(k);
    }, 60000);
    sweep.unref();
    host.cleanup(() => clearInterval(sweep));
    host.validateConfig((c) => {
      for (const [id, p] of Object.entries(
        (c.profiles ?? {}) as Record<string, RoutingProfile>,
      )) {
        requiredString(id, "profile");
        const ids = new Set<string>();
        if (!p.candidates.length)
          throw new HostError(
            "invalid_config",
            "A router profile needs candidates",
          );
        for (const candidate of p.candidates) {
          if (ids.has(candidate.id))
            throw new HostError(
              "invalid_config",
              "Duplicate routing candidate",
            );
          ids.add(candidate.id);
          if (
            candidate.defaultEffort &&
            !candidate.reasoningEfforts?.includes(candidate.defaultEffort)
          )
            throw new HostError(
              "invalid_config",
              "Default effort must be declared by the candidate",
            );
        }
        if (
          ["effort", "manual"].includes(p.mode) &&
          !ids.has(p.fixedCandidate!)
        )
          throw new HostError(
            "invalid_config",
            "This mode needs a fixed candidate",
          );
        if (
          p.onFailure !== "reject" &&
          p.mode !== "manual" &&
          !ids.has(p.fallbackCandidate!)
        )
          throw new HostError(
            "invalid_config",
            "Configure a fallback candidate or reject failures",
          );
        if (
          p.mode === "effort" &&
          p.fallbackCandidate &&
          p.fallbackCandidate !== p.fixedCandidate
        )
          throw new HostError(
            "invalid_config",
            "Effort-only mode cannot switch models on failure",
          );
        if (p.decision.kind !== "rules") {
          if (
            !p.decision.baseUrl ||
            (!p.decision.model && p.decision.kind !== "jev")
          )
            throw new HostError(
              "invalid_config",
              "Decision service URL and model are required",
            );
          let url: URL;
          try {
            url = new URL(p.decision.baseUrl);
          } catch {
            throw new HostError("invalid_config", "Invalid decision URL");
          }
          if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
          )
            throw new HostError("invalid_config", "Invalid decision URL");
          if (
            p.decision.keyRef &&
            !((c.secretRefs ?? []) as string[]).includes(p.decision.keyRef)
          )
            throw new HostError(
              "invalid_config",
              "Authorize the decision secret reference",
            );
        }
      }
    });
    async function resolve(
      input: AutoRoutingInput,
      signal: AbortSignal,
    ): Promise<AIPlan> {
      signal.throwIfAborted();
      const start = performance.now();
      const p = profiles()[requiredString(input.profile, "profile")];
      if (!p)
        throw new HostError(
          "profile_not_found",
          "Router profile not found",
          404,
        );
      if (
        !input.request ||
        !Array.isArray(input.request.messages) ||
        !Array.isArray(input.request.tools)
      )
        throw new HostError("invalid_request", "A decoded request is required");
      const explicit = input.request.reasoning?.effort;
      if (
        input.request.reasoning?.budgetTokens !== undefined &&
        ["effort", "both"].includes(p.mode) &&
        p.preserveClientEffort !== false
      )
        throw new HostError(
          "unsupported_reasoning",
          "Use an effort setting or model-only mode to preserve an explicit thinking budget",
        );
      const keep = !!explicit && p.preserveClientEffort !== false;
      const inputBytes = Buffer.byteLength(
        JSON.stringify({
          messages: input.request.messages,
          tools: input.request.tools,
        }),
      );
      const requestedSize = inputBytes + (input.request.maxTokens ?? 0);
      const eligible: Eligible[] = [];
      for (const candidate of p.candidates) {
        if (candidate.enabled === false) continue;
        let target: { plan: AIPlan; route: ModelRoute };
        try {
          target = await host.call(
            "ai.targets@1",
            {
              target: candidate.target,
              request: input.request,
              ingressProtocol: input.ingressProtocol,
              protocolPolicy: input.protocolPolicy,
              principalId: input.principalId,
              groupId: input.groupId,
              allowedChannelIds: input.allowedChannelIds,
            },
            signal,
          );
        } catch (e) {
          if (
            [
              "model_not_found",
              "subscription_unavailable",
              "protocol_not_allowed",
              "protocol_conversion_forbidden",
              "web_search_unsupported",
              "interface_not_supported",
              "operation_not_supported",
              "search_usage_unavailable",
            ].includes((e as HostError).code)
          )
            continue;
          throw e;
        }
        if (
          target.route.contextWindow &&
          requestedSize > target.route.contextWindow
        )
          continue;
        const declared =
          candidate.reasoningEfforts ?? target.route.reasoningEfforts ?? [];
        const protocol = target.plan.upstream.protocol;
        const wireProtocol =
          protocol === "codex" || protocol === "grok"
            ? "openai-responses"
            : protocol === "claude-subscription"
              ? "anthropic"
              : protocol === "antigravity"
                ? "gemini"
                : protocol;
        if (!wireProtocol || wireProtocol === "auto-router")
          throw new HostError(
            "routing_cycle",
            "Automatic router targets must be physical providers",
          );
        const allowed = declared
          .filter(
            (e) =>
              !target.route.reasoningEfforts ||
              target.route.reasoningEfforts.includes(e),
          )
          .filter((e) => {
            try {
              encodeReasoning(wireProtocol, { effort: e });
              return true;
            } catch {
              return false;
            }
          });
        if (
          p.mode === "model" &&
          input.request.reasoning?.budgetTokens !== undefined
        ) {
          try {
            encodeReasoning(wireProtocol, input.request.reasoning);
          } catch {
            continue;
          }
        }
        if (keep && !allowed.includes(explicit!)) continue;
        if (["effort", "both"].includes(p.mode) && !keep && !allowed.length)
          continue;
        if (
          target.plan.upstream.protocol === "codex" &&
          target.plan.upstream.authMode === "cli" &&
          (input.request.maxTokens !== undefined ||
            input.request.temperature !== undefined)
        )
          continue;
        eligible.push({ candidate, ...target, allowed });
      }
      if (!eligible.length)
        throw new HostError(
          "no_route",
          "No compatible model candidate is available",
          503,
        );
      let result: DifficultyDecision = {
        difficulty: "standard",
        confidence: 1,
        source: "manual",
      };
      let fallback: string | undefined;
      if (p.mode !== "manual") {
        try {
          if (p.decision.kind !== "rules") {
            if (active >= Number(host.config().decisionConcurrency ?? 8))
              throw new HostError(
                "decision_rate_limited",
                "Decision concurrency limit exceeded",
                429,
              );
            const owner = input.principalId ?? "management";
            const minute = Math.floor(Date.now() / 60000);
            let bucket = windows.get(owner);
            if (!bucket || bucket.minute !== minute) {
              bucket = { minute, count: 0 };
              windows.set(owner, bucket);
            }
            if (bucket.count >= Number(host.config().decisionRpm ?? 60))
              throw new HostError(
                "decision_rate_limited",
                "Decision quota exceeded",
                429,
              );
            bucket.count++;
          }
          active++;
          try {
            result = await decide(host, p.decision, input.request, signal);
          } finally {
            active--;
          }
          if (result.truncated)
            throw new HostError(
              "decision_truncated",
              "Decision evidence was truncated",
            );
          if (result.confidence < (p.minConfidence ?? 0.65))
            throw new HostError(
              "decision_confidence",
              "Decision confidence below threshold",
            );
        } catch (e) {
          signal.throwIfAborted();
          if (
            p.onFailure === "reject" ||
            (e as HostError).code === "decision_rate_limited"
          )
            throw new HostError(
              (e as HostError).code ?? "decision_unavailable",
              "Automatic routing decision unavailable",
              (e as HostError).status === 429 ? 429 : 503,
            );
          fallback = (e as HostError).code ?? "decision_unavailable";
          result = { difficulty: "hard", confidence: 0, source: "fallback" };
        }
      }
      let chosen: Eligible | undefined;
      if (fallback)
        chosen = eligible.find((x) => x.candidate.id === p.fallbackCandidate);
      else if (p.mode === "manual" || p.mode === "effort")
        chosen = eligible.find((x) => x.candidate.id === p.fixedCandidate);
      else {
        const needed =
          p.difficultyStrength?.[result.difficulty] ??
          { easy: 20, standard: 45, hard: 70, expert: 95 }[result.difficulty];
        let candidates = eligible.filter((x) => x.candidate.strength >= needed);
        if (!candidates.length) {
          candidates = [...eligible]
            .sort((a, b) => b.candidate.strength - a.candidate.strength)
            .slice(0, 1);
          fallback = "strength_ceiling";
        }
        const price = (x: Eligible) => {
          if (!x.plan.pricing) return Infinity;
          try {
            return priceUsage(
              { input: inputBytes, output: input.request.maxTokens ?? 4096 },
              bindPricingContext(
                x.plan.pricing,
                input.pricingContext ?? capturePricingContext(input.request),
              ),
            ).amount;
          } catch {
            return Infinity;
          }
        };
        if (p.strategy === "quality")
          candidates.sort(
            (a, b) =>
              b.candidate.strength - a.candidate.strength ||
              a.candidate.id.localeCompare(b.candidate.id),
          );
        else if (p.strategy === "cost")
          candidates.sort(
            (a, b) =>
              price(a) - price(b) ||
              a.candidate.strength - b.candidate.strength ||
              a.candidate.id.localeCompare(b.candidate.id),
          );
        else
          candidates.sort(
            (a, b) =>
              a.candidate.strength - b.candidate.strength ||
              price(a) - price(b) ||
              a.candidate.id.localeCompare(b.candidate.id),
          );
        chosen = candidates[0];
      }
      if (!chosen)
        throw new HostError(
          "no_route",
          "Configured fixed or fallback model is unavailable",
          503,
        );
      let selected: ReasoningEffort | undefined = keep ? explicit : undefined;
      if (!selected) {
        if (
          result.source === "fallback" &&
          (p.fallbackEffort ?? chosen.candidate.defaultEffort)
        )
          selected = p.fallbackEffort ?? chosen.candidate.defaultEffort;
        else if (p.mode === "manual")
          selected = p.fixedEffort ?? chosen.candidate.defaultEffort;
        else if (p.mode === "model") selected = chosen.candidate.defaultEffort;
        else {
          const desired =
            p.effortByDifficulty?.[result.difficulty] ??
            (
              {
                easy: "low",
                standard: "medium",
                hard: "high",
                expert: "max",
              } as const
            )[result.difficulty];
          selected =
            [...chosen.allowed]
              .sort((a, b) => efforts.indexOf(a) - efforts.indexOf(b))
              .find((e) => efforts.indexOf(e) >= efforts.indexOf(desired)) ??
            [...chosen.allowed].sort(
              (a, b) => efforts.indexOf(b) - efforts.indexOf(a),
            )[0];
        }
      }
      if (selected && !chosen.allowed.includes(selected))
        throw new HostError(
          "unsupported_reasoning",
          "Configured effort is not supported by selected model",
        );
      const reasoning = selected
        ? {
            ...(p.mode === "model" &&
            input.request.reasoning?.budgetTokens !== undefined
              ? { budgetTokens: input.request.reasoning.budgetTokens }
              : {}),
            effort: selected,
          }
        : input.request.reasoning;
      return {
        ...chosen.plan,
        targetModelId: chosen.candidate.target,
        ...(reasoning ? { reasoning } : {}),
        decision: {
          profile: input.profile,
          mode: p.mode,
          difficulty: result.difficulty,
          confidence: result.confidence,
          source: result.source,
          candidate: chosen.candidate.id,
          elapsedMs: Math.round(performance.now() - start),
          ...(fallback ? { fallback } : {}),
        },
      };
    }
    host.provide("ai.auto-routing@1", resolve);
    host.provide(
      "ai.upstream.auto-router@1",
      async ({ request }: { request: AIRequest }, signal) => {
        const plan = await resolve({ profile: request.model, request }, signal);
        const events = await host.call<AsyncIterable<AIEvent>>(
          plan.capability,
          {
            upstream: plan.upstream,
            request: {
              ...request,
              model: plan.model,
              reasoning: plan.reasoning,
            },
          },
          signal,
        );
        return events;
      },
    );
    host.api({
      method: "GET",
      path: "/targets",
      access: "host.manage",
      handle: async () => json(await host.call("ai.targets@1")),
    });
    host.api({
      method: "GET",
      path: "/profiles",
      access: "host.manage",
      handle: () => json(profiles()),
    });
    host.api({
      method: "POST",
      path: "/preview",
      access: "host.manage",
      handle: async (r, ctx) => {
        const b = await readObject(r, 65536);
        const text = requiredString(b.text, "text", 32000);
        const plan = await resolve(
          {
            profile: requiredString(b.profile, "profile"),
            principalId: ctx.principal!.id,
            request: {
              model: "preview",
              messages: [{ role: "user", text }],
              tools: [],
              stream: false,
              maxTokens: 1024,
            },
          },
          ctx.signal,
        );
        return json({
          target: plan.targetModelId,
          channel: plan.upstreamId,
          model: plan.model,
          reasoning: plan.reasoning,
          decision: plan.decision,
          pricing: plan.pricing,
        });
      },
    });
  },
});
