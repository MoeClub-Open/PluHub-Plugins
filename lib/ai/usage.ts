import type { Protocol, Usage } from "@pluhub/contracts/ai";
import { validateUsage } from "../commerce/pricing.js";

/** Preserve provider totals and cache subsets without charging cached tokens twice. */
export function decodeUsage(protocol: Protocol, raw: any): Usage | undefined {
  if (!raw || typeof raw !== "object") return;
  const usage: Usage =
    protocol === "openai-chat"
      ? { input: raw.prompt_tokens, output: raw.completion_tokens }
      : protocol === "gemini"
        ? { input: raw.promptTokenCount, output: raw.candidatesTokenCount }
        : { input: raw.input_tokens, output: raw.output_tokens };
  if (usage.input === undefined || usage.output === undefined) return;
  const set = (key: keyof Usage, value: any) => {
    if (value !== undefined && value !== null) usage[key] = value;
  };
  if (protocol === "openai-chat" || protocol === "openai-responses") {
    const input = raw.prompt_tokens_details ?? raw.input_tokens_details;
    const output = raw.completion_tokens_details ?? raw.output_tokens_details;
    set("cacheRead", input?.cached_tokens);
    set("cacheWrite", input?.cache_write_tokens ?? input?.cache_creation_tokens);
    set("reasoning", output?.reasoning_tokens);
  } else if (protocol === "anthropic") {
    set("cacheRead", raw.cache_read_input_tokens);
    const split = raw.cache_creation;
    const five = split?.ephemeral_5m_input_tokens;
    const hour = split?.ephemeral_1h_input_tokens;
    // Validate split fields before adding them; strings must not be coerced.
    if (five !== undefined) validateUsage({ input: five, output: 0 });
    if (hour !== undefined) validateUsage({ input: hour, output: 0 });
    set(
      "cacheWrite",
      raw.cache_creation_input_tokens ??
        (split ? (five ?? 0) + (hour ?? 0) : undefined),
    );
    set("cacheWrite1h", hour);
    if (split && (five ?? 0) + (hour ?? 0) > (usage.cacheWrite ?? 0))
      validateUsage({ input: 0, output: 0, cacheWrite: 1 });
    validateUsage({ input: usage.input, output: usage.output });
    if (usage.cacheRead !== undefined)
      validateUsage({ input: usage.cacheRead, output: 0 });
    if (usage.cacheWrite !== undefined)
      validateUsage({ input: usage.cacheWrite, output: 0 });
    usage.input += (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  } else {
    set("cacheRead", raw.cachedContentTokenCount);
    set("reasoning", raw.thoughtsTokenCount);
    validateUsage({ input: usage.input, output: usage.output });
    if (usage.reasoning !== undefined)
      validateUsage({ input: 0, output: usage.reasoning });
    usage.output += usage.reasoning ?? 0;
  }
  validateUsage(usage);
  return usage;
}

export function encodeUsage(protocol: Protocol, usage: Usage): any {
  if (protocol === "openai-chat" || protocol === "openai-responses") {
    const chat = protocol === "openai-chat";
    return {
      [chat ? "prompt_tokens" : "input_tokens"]: usage.input,
      [chat ? "completion_tokens" : "output_tokens"]: usage.output,
      total_tokens: usage.input + usage.output,
      ...(usage.cacheRead !== undefined || usage.cacheWrite !== undefined
        ? {
            [chat ? "prompt_tokens_details" : "input_tokens_details"]: {
              ...(usage.cacheRead !== undefined
                ? { cached_tokens: usage.cacheRead }
                : {}),
              ...(usage.cacheWrite !== undefined
                ? { cache_write_tokens: usage.cacheWrite }
                : {}),
            },
          }
        : {}),
      ...(usage.reasoning !== undefined
        ? {
            [chat ? "completion_tokens_details" : "output_tokens_details"]: {
              reasoning_tokens: usage.reasoning,
            },
          }
        : {}),
    };
  }
  if (protocol === "anthropic")
    return {
      input_tokens:
        usage.input - (usage.cacheRead ?? 0) - (usage.cacheWrite ?? 0),
      output_tokens: usage.output,
      ...(usage.cacheRead !== undefined
        ? { cache_read_input_tokens: usage.cacheRead }
        : {}),
      ...(usage.cacheWrite !== undefined
        ? { cache_creation_input_tokens: usage.cacheWrite }
        : {}),
      ...(usage.cacheWrite1h !== undefined
        ? {
            cache_creation: {
              ephemeral_5m_input_tokens:
                (usage.cacheWrite ?? 0) - usage.cacheWrite1h,
              ephemeral_1h_input_tokens: usage.cacheWrite1h,
            },
          }
        : {}),
    };
  return {
    promptTokenCount: usage.input,
    candidatesTokenCount: usage.output - (usage.reasoning ?? 0),
    totalTokenCount: usage.input + usage.output,
    ...(usage.cacheRead !== undefined
      ? { cachedContentTokenCount: usage.cacheRead }
      : {}),
    ...(usage.reasoning !== undefined
      ? { thoughtsTokenCount: usage.reasoning }
      : {}),
  };
}
