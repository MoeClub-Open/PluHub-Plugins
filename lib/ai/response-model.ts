import type { Protocol } from "@pluhub/contracts/ai";

/** Read only a model identifier actually present in an upstream response. */
export function responseModel(
  protocol: Protocol,
  data: any,
  stream = false,
): string | undefined {
  const value =
    protocol === "gemini"
      ? data?.modelVersion
      : stream && protocol === "openai-responses"
        ? data?.response?.model
        : stream && protocol === "anthropic"
          ? data?.type === "message_start"
            ? data.message?.model
            : undefined
          : data?.model;
  if (typeof value !== "string" || value.length > 256) return undefined;
  return value.trim() ? value : undefined;
}
