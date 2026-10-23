import { HostError } from "@pluhub/sdk";
import type {
  Reasoning,
  ReasoningEffort,
  Protocol,
} from "@pluhub/contracts/ai";
export const efforts: ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
export const geminiEffort = (value: ReasoningEffort) =>
  value === "xhigh" || value === "max" ? "high" : value;
export function effort(value: unknown): ReasoningEffort {
  if (!efforts.includes(value as ReasoningEffort))
    throw new HostError(
      "unsupported_reasoning",
      "Unsupported reasoning effort",
    );
  return value as ReasoningEffort;
}
function keys(value: any, allowed: string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !allowed.includes(k))
  )
    throw new HostError(
      "unsupported_reasoning",
      "Unsupported thinking settings",
    );
}
function budget(n: unknown): number {
  if (!Number.isSafeInteger(n) || Number(n) < 0 || Number(n) > 1000000)
    throw new HostError("invalid_reasoning", "Invalid thinking token budget");
  return Number(n);
}
export function decodeReasoning(
  protocol: Protocol,
  body: any,
): Reasoning | undefined {
  if (protocol === "openai-chat")
    return body.reasoning_effort !== undefined
      ? { effort: effort(body.reasoning_effort) }
      : undefined;
  if (protocol === "openai-responses") {
    if (
      body.reasoning === undefined &&
      !body.include?.includes("reasoning.encrypted_content")
    )
      return;
    if (body.reasoning !== undefined)
      keys(body.reasoning, ["effort", "summary"]);
    const r: Reasoning = body.include?.includes("reasoning.encrypted_content")
      ? { encryptedContent: true }
      : {};
    if (body.reasoning?.effort !== undefined)
      r.effort = effort(body.reasoning.effort);
    if (body.reasoning?.summary !== undefined) {
      if (!["auto", "concise", "detailed"].includes(body.reasoning.summary))
        throw new HostError("invalid_reasoning", "Invalid reasoning summary");
      r.summary = body.reasoning.summary;
    }
    return r;
  }
  if (protocol === "anthropic") {
    const r: Reasoning = {};
    if (body.output_config !== undefined) {
      keys(body.output_config, ["effort", "format"]);
      if (body.output_config.effort !== undefined)
        r.effort = effort(body.output_config.effort);
    }
    if (body.thinking !== undefined) {
      keys(body.thinking, ["type", "budget_tokens"]);
      const t = body.thinking;
      if (t.type === "disabled") {
        if (r.effort && r.effort !== "none")
          throw new HostError(
            "invalid_reasoning",
            "Conflicting thinking settings",
          );
        r.effort = "none";
        if (t.budget_tokens !== undefined)
          throw new HostError(
            "invalid_reasoning",
            "Disabled thinking has no budget",
          );
      } else if (t.type === "enabled") {
        r.budgetTokens = budget(t.budget_tokens);
        if (r.budgetTokens < 1024 || r.effort === "none")
          throw new HostError(
            "invalid_reasoning",
            "Anthropic enabled thinking requires at least 1024 tokens",
          );
      } else if (t.type === "adaptive") {
        if (t.budget_tokens !== undefined || r.effort === "none")
          throw new HostError(
            "invalid_reasoning",
            "Adaptive thinking cannot have a budget or be disabled",
          );
        r.adaptive = true;
      } else
        throw new HostError(
          "unsupported_reasoning",
          "Unsupported Anthropic thinking mode",
        );
    }
    return Object.keys(r).length ? r : undefined;
  }
  const t = body.generationConfig?.thinkingConfig;
  if (t === undefined) return;
  keys(t, ["thinkingLevel", "thinkingBudget", "includeThoughts"]);
  if (t.includeThoughts !== undefined && typeof t.includeThoughts !== "boolean")
    throw new HostError("invalid_reasoning", "Invalid includeThoughts");
  const extra =
    t.includeThoughts !== undefined
      ? { includeThoughts: t.includeThoughts }
      : {};
  if (t.thinkingLevel !== undefined && t.thinkingBudget !== undefined)
    throw new HostError("invalid_reasoning", "Choose thinking level or budget");
  if (t.thinkingLevel !== undefined)
    return { effort: effort(String(t.thinkingLevel).toLowerCase()), ...extra };
  if (t.thinkingBudget !== undefined)
    return { budgetTokens: budget(t.thinkingBudget), ...extra };
  if (t.includeThoughts !== undefined) return extra;
  throw new HostError("invalid_reasoning", "Empty thinking config");
}
export function encodeReasoning(
  protocol: Protocol,
  r: Reasoning | undefined,
): Record<string, any> {
  if (!r) return {};
  if (
    r.encryptedContent &&
    protocol !== "openai-responses" &&
    protocol !== "gemini"
  )
    throw new HostError(
      "unsupported_reasoning",
      "Encrypted reasoning output requires Responses",
    );
  if (r.effort !== undefined) effort(r.effort);
  if (r.budgetTokens !== undefined) budget(r.budgetTokens);
  if (protocol.startsWith("openai")) {
    if (r.adaptive !== undefined || r.includeThoughts !== undefined)
      throw new HostError(
        "unsupported_reasoning",
        "OpenAI cannot represent adaptive thinking or includeThoughts",
      );
    if (r.budgetTokens !== undefined)
      throw new HostError(
        "unsupported_reasoning",
        "OpenAI requires effort rather than a token budget",
      );
    if (protocol === "openai-chat") {
      if (r.summary !== undefined)
        throw new HostError(
          "unsupported_reasoning",
          "Chat Completions cannot request reasoning summaries",
        );
      return r.effort === undefined ? {} : { reasoning_effort: r.effort };
    }
    return {
      ...(r.effort !== undefined || r.summary
        ? {
            reasoning: {
              ...(r.effort !== undefined ? { effort: r.effort } : {}),
              ...(r.summary ? { summary: r.summary } : {}),
            },
          }
        : {}),
      ...(r.encryptedContent
        ? { include: ["reasoning.encrypted_content"] }
        : {}),
    };
  }
  if (protocol === "anthropic") {
    if (r.summary !== undefined || r.includeThoughts !== undefined)
      throw new HostError(
        "unsupported_reasoning",
        "Anthropic cannot represent these reasoning display settings",
      );
    if (r.adaptive && (r.budgetTokens !== undefined || r.effort === "none"))
      throw new HostError(
        "invalid_reasoning",
        "Invalid adaptive thinking settings",
      );
    if (
      r.budgetTokens !== undefined &&
      (r.budgetTokens < 1024 || r.effort === "none")
    )
      throw new HostError(
        "unsupported_reasoning",
        "Anthropic thinking budget must be at least 1024",
      );
    return {
      ...(r.effort === "none"
        ? { thinking: { type: "disabled" } }
        : r.effort
          ? { output_config: { effort: r.effort } }
          : {}),
      ...(r.budgetTokens !== undefined
        ? { thinking: { type: "enabled", budget_tokens: r.budgetTokens } }
        : {}),
      ...(r.adaptive ? { thinking: { type: "adaptive" } } : {}),
    };
  }
  if (r.adaptive !== undefined)
    throw new HostError(
      "unsupported_reasoning",
      "Gemini cannot represent these reasoning settings",
    );
  if (r.effort !== undefined && r.budgetTokens !== undefined)
    throw new HostError(
      "unsupported_reasoning",
      "Gemini requires a thinking level or budget",
    );
  const level = r.effort ? geminiEffort(r.effort) : undefined;
  if (level && !["none", "minimal", "low", "medium", "high"].includes(level))
    throw new HostError(
      "unsupported_reasoning",
      "Gemini cannot represent this thinking level",
    );
  return {
    thinkingConfig: {
      ...(level === "none"
        ? { thinkingBudget: 0 }
        : level
          ? { thinkingLevel: level.toUpperCase() }
          : r.budgetTokens !== undefined
            ? { thinkingBudget: r.budgetTokens }
            : {}),
      ...(r.includeThoughts !== undefined || r.summary || r.encryptedContent
        ? { includeThoughts: r.includeThoughts ?? true }
        : {}),
    },
  };
}
