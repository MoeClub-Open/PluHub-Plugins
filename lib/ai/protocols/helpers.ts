import { HostError, requiredString } from "@pluhub/sdk";
import type { Message, Protocol } from "@pluhub/contracts/ai";
import { assertReasoningTarget, object, readReasoning, string } from "../content.js";

export const unsupported = (field: string): never => {
  throw new HostError("unsupported_feature", "Unsupported feature: " + field);
};
export function fields(value: any, allowed: string[], where = "request") {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HostError("invalid_request", "Invalid " + where);
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) unsupported(where + "." + key);
}
export function text(value: any): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (Array.isArray(value))
    return value
      .map((v) => {
        if (
          !["text", "input_text", "output_text"].includes(v.type) ||
          typeof v.text !== "string"
        )
          return unsupported("non-text content");
        return v.text;
      })
      .join("");
  return unsupported("content");
}
export function number(value: any, name: string, min: number, max: number) {
  if (
    value !== undefined &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < min ||
      value > max)
  )
    throw new HostError("invalid_request", "Invalid " + name);
  return value as number | undefined;
}
export function role(value: any): Message["role"] {
  if (!["system", "developer", "user", "assistant", "tool"].includes(value))
    throw new HostError("invalid_request", "Invalid message role");
  return value;
}
export function call(value: any) {
  object(value, "tool call");
  if (value.type && !["function", "function_call"].includes(value.type))
    unsupported("tool type");
  const signature = value.extra_content?.google?.thought_signature;
  if (value.extra_content) {
    fields(value.extra_content, ["google"], "tool extra_content");
    fields(value.extra_content.google, ["thought_signature"], "google");
  }
  return {
    id: requiredString(value.call_id ?? value.id, "tool call id"),
    name: requiredString(value.function?.name ?? value.name, "tool name"),
    arguments:
      string(
        value.function?.arguments ?? value.arguments ?? "{}",
        "tool arguments",
      ) || "{}",
    ...(signature !== undefined
      ? { thoughtSignature: string(signature, "thought signature") }
      : {}),
  };
}
export function readReasoningDetails(value: any) {
  if (!Array.isArray(value) || value.length > 128)
    throw new HostError("invalid_request", "Invalid reasoning details");
  return value.map((d) => {
    fields(
      d,
      ["type", "text", "signature", "data", "format", "id", "index"],
      "reasoning details",
    );
    if (
      !["reasoning.text", "reasoning.encrypted"].includes(d.type) ||
      !["openai-chat", "openai-responses", "anthropic", "gemini"].includes(
        d.format,
      )
    )
      unsupported("reasoning details format");
    return readReasoning(d.format, d.text ?? "", d.signature, {
      ...(d.id ? { id: string(d.id, "reasoning id") } : {}),
      ...(d.data
        ? d.type === "reasoning.encrypted" && d.format === "anthropic"
          ? { redacted: string(d.data, "redacted thinking") }
          : { encrypted: string(d.data, "encrypted reasoning") }
        : {}),
    });
  });
}
export function reasoningHistory(protocol: Protocol, message: Message): any[] {
  return (message.reasoning ?? []).map((b) => {
    assertReasoningTarget(b, protocol);
    if (protocol === "anthropic")
      return b.redacted
        ? { type: "redacted_thinking", data: b.redacted }
        : {
            type: "thinking",
            thinking: b.text,
            ...(b.signature ? { signature: b.signature } : {}),
          };
    if (protocol === "gemini")
      return {
        text: b.text,
        thought: true,
        ...(b.signature ? { thoughtSignature: b.signature } : {}),
      };
    return {
      type: "reasoning",
      ...(b.id ? { id: b.id } : {}),
      summary: b.text ? [{ type: "summary_text", text: b.text }] : [],
      ...(b.encrypted ? { encrypted_content: b.encrypted } : {}),
    };
  });
}

export const parseArgs = (value: string) => {
  try {
    return object(JSON.parse(value), "tool arguments");
  } catch {
    throw new HostError(
      "invalid_tool_arguments",
      "Tool arguments must be JSON",
    );
  }
};
export function mergeMessages(items: any[], field: "content" | "parts") {
  return items.reduce<any[]>((out, item) => {
    const last = out.at(-1);
    if (last?.role === item.role) last[field].push(...item[field]);
    else out.push(item);
    return out;
  }, []);
}

export function tryJSON(value: string) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : { result: parsed };
  } catch {
    return { result: value };
  }
}
