import type {
  AIRequest,
  Reasoning,
  ReasoningEffort,
} from "@pluhub/contracts/ai";
import { geminiEffort } from "./reasoning.js";

// Antigravity exposes these Gemini families as separate thinking variants.
const variants: Record<string, readonly ReasoningEffort[]> = {
  "gemini-3-pro": ["low", "high"],
  "gemini-3.1-pro": ["low", "high"],
  "gemini-3.6-flash": ["low", "medium", "high"],
  "gemini-3.7-flash": ["low", "medium", "high"],
  "gemini-3.8-flash": ["low", "medium", "high"],
  "gemini-4-argon": ["low", "medium", "high"],
};

function thinkingLevel(reasoning: Reasoning | undefined) {
  if (reasoning?.effort) {
    const effort = geminiEffort(reasoning.effort);
    return effort === "none" || effort === "minimal" ? "low" : effort;
  }
  const budget = reasoning?.budgetTokens;
  if (budget === undefined) return undefined;
  return budget < 0
    ? "high"
    : budget <= 1024
      ? "low"
      : budget <= 8192
        ? "medium"
        : "high";
}

/** Normalize before account selection so quota cooldowns use the dispatched model. */
export function prepareAntigravityRequest(request: AIRequest): AIRequest {
  const originalModel = request.model.replace(/^models\//, "");
  if (!originalModel.startsWith("gemini-")) return request;
  const suffix = /-(low|medium|high|tiered)$/.exec(originalModel)?.[1];
  const family = suffix
    ? originalModel.slice(0, -suffix.length - 1)
    : originalModel;
  const levels = variants[family];
  let model = originalModel;
  let reasoning = request.reasoning;
  const preferred = thinkingLevel(reasoning);
  if (levels && (preferred || !suffix)) {
    const level = preferred && levels.includes(preferred) ? preferred : "high";
    model = `${family}-${level}`;
    if (reasoning?.effort && reasoning.effort !== "none")
      reasoning = { ...reasoning, effort: level };
  }
  // Effort controls compute; includeThoughts controls whether Gemini returns summaries.
  // Preserve an explicit opt-out and do not turn disabled thinking back on.
  if (reasoning || levels || /^gemini-(?:3|4)(?:[.-])/.test(originalModel))
    reasoning = {
      ...reasoning,
      includeThoughts:
        reasoning?.includeThoughts ??
        (reasoning?.effort !== "none" && reasoning?.budgetTokens !== 0),
    };
  return { ...request, model, ...(reasoning ? { reasoning } : {}) };
}
