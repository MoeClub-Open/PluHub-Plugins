import type { AIPlan, AIRequest, Upstream } from "@pluhub/contracts/ai";
import { HostError } from "@pluhub/sdk";
import { fixedPricing } from "../commerce/expression.js";
import { isDecisionProtocol } from "./decision-route-kind.js";

export type OutputBudgetMode = "automatic" | "bounded" | "estimate";
export interface OutputBudget {
  mode: "bounded" | "estimate" | "fixed";
  source: "explicit" | "default";
  limit?: number;
  reservedTokens: number;
  thinkingTokens?: number;
}
const maxOutputTokens = 1_000_000;
export const supportsOutputLimit = (upstream: Upstream) =>
  !(
    isDecisionProtocol(upstream.protocol) ||
    (upstream.protocol === "codex" &&
      (upstream.authMode === "cli" ||
        (!upstream.authMode && !!upstream.subscriptionAccountIds)))
  );
export function normalizeOutputOptions(
  request: AIRequest,
  upstream: Upstream,
): AIRequest {
  if (supportsOutputLimit(upstream)) return request;
  const {
    maxTokens: _maxTokens,
    temperature: _temperature,
    ...supported
  } = request;
  return supported;
}
export function validateOutputBudget(config: Record<string, unknown>) {
  const mode = config.outputBudgetMode ?? "automatic";
  if (
    typeof mode !== "string" ||
    !["automatic", "bounded", "estimate"].includes(mode)
  )
    throw new HostError("invalid_config", "Invalid output budget mode");
  const tokens = config.reserveOutputTokens ?? 4096;
  if (
    !Number.isSafeInteger(tokens) ||
    Number(tokens) < 1 ||
    Number(tokens) > 100_000_000 ||
    (mode !== "estimate" && Number(tokens) > maxOutputTokens)
  )
    throw new HostError(
      "invalid_config",
      "Invalid default output token budget",
    );
}

/** The final channel request and reasoning override determine both reservation and execution. */
export function outputBudget(
  original: AIRequest,
  plan: AIPlan,
  config: Record<string, unknown>,
): { request: AIRequest; budget: OutputBudget } {
  const media = (plan.preparedRequest ?? original).operation;
  if (media) {
    if (
      media.kind !== "embeddings" &&
      plan.pricing &&
      !fixedPricing(plan.pricing)
    )
      throw new HostError(
        "media_price_required",
        "Configure per-request or fixed expression pricing for this media model",
        503,
      );
    return {
      request: plan.preparedRequest ?? original,
      budget: {
        mode:
          media.kind === "embeddings" &&
          plan.pricing &&
          !fixedPricing(plan.pricing)
            ? "estimate"
            : "fixed",
        source: "default",
        reservedTokens: 0,
      },
    };
  }
  const prepared = normalizeOutputOptions(
    plan.preparedRequest ?? original,
    plan.upstream,
  );
  const reasoning = plan.reasoning ?? prepared.reasoning;
  const protocol = plan.upstream.protocol;
  const anthropic =
    protocol === "anthropic" || protocol === "claude-subscription";
  const gemini = protocol === "gemini" || protocol === "antigravity";
  const cli = !supportsOutputLimit(plan.upstream);
  const mode = (config.outputBudgetMode ?? "automatic") as OutputBudgetMode;
  const fixed = plan.pricing ? fixedPricing(plan.pricing) : false;
  const bounded = mode !== "estimate" && !cli;
  if (mode === "bounded" && cli && !fixed)
    throw new HostError(
      "output_budget_unsupported",
      "This upstream cannot enforce an output token limit; choose an upstream with output limits or an explicit estimation policy",
      503,
    );
  const source = prepared.maxTokens !== undefined ? "explicit" : "default";
  // Gemini's -1 selects dynamic thinking; the output cap still covers its usage.
  const thinkingTokens =
    gemini && reasoning?.budgetTokens === -1
      ? 0
      : (reasoning?.budgetTokens ?? 0);
  if (
    !Number.isSafeInteger(thinkingTokens) ||
    thinkingTokens < 0 ||
    thinkingTokens > maxOutputTokens
  )
    throw new HostError("invalid_reasoning", "Invalid thinking token budget");
  const limit =
    prepared.maxTokens ??
    Math.max(
      Number(config.reserveOutputTokens ?? 4096),
      (anthropic || gemini) && thinkingTokens ? thinkingTokens + 1024 : 0,
    );
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    (bounded && limit > maxOutputTokens)
  )
    throw new HostError("invalid_request", "Invalid output token budget");
  if (anthropic && thinkingTokens >= limit)
    throw new HostError(
      "invalid_reasoning",
      "Thinking budget must be smaller than max_tokens",
    );
  // Normalized output includes thoughts; they are covered by the output cap, never charged twice.
  const reservedTokens = limit;
  if (!Number.isSafeInteger(reservedTokens))
    throw new HostError("invalid_request", "Invalid output token budget");
  return {
    request: bounded ? { ...prepared, maxTokens: limit } : prepared,
    budget: {
      mode:
        fixed && !bounded
          ? "fixed"
          : bounded || prepared.maxTokens !== undefined
            ? "bounded"
            : "estimate",
      source,
      ...(bounded || prepared.maxTokens !== undefined ? { limit } : {}),
      reservedTokens: fixed && !bounded ? 0 : reservedTokens,
      ...(thinkingTokens ? { thinkingTokens } : {}),
    },
  };
}
