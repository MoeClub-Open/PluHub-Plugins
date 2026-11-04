import { randomUUID } from "node:crypto";
import { HostError, requiredString } from "@pluhub/sdk";
import type { AIEvent, AIResult, Protocol } from "@pluhub/contracts/ai";
import { object, readReasoning, string } from "../content.js";
import { decodeUsage } from "../usage.js";
import { readCitations, readSearchCall } from "../web-search.js";
import { call, parseArgs, readReasoningDetails, text, unsupported } from "./helpers.js";

export function decodeResult(
  protocol: Protocol,
  data: any,
  model: string,
): AIResult {
  object(data, "upstream response");
  const result: AIResult = {
    id: data.id ?? "resp_" + randomUUID(),
    model,
    text: "",
    calls: [],
    usage: { input: 0, output: 0 },
    reason: "stop",
  };
  if (protocol === "openai-chat") {
    const c = data.choices?.[0];
    if (data.choices?.length > 1 || (c?.index !== undefined && c.index !== 0))
      unsupported("multiple completion choices");
    if (!c)
      throw new HostError(
        "upstream_protocol",
        "Missing completion choice",
        502,
      );
    result.text = text(c.message?.content);
    if (c.message?.annotations?.length)
      result.citations = readCitations(c.message.annotations);
    if (c.message?.extra_content?.web_search_calls)
      result.searchCalls =
        c.message.extra_content.web_search_calls.map(readSearchCall);
    if (c.message?.refusal)
      result.refusal = string(c.message.refusal, "refusal");
    if (c.message?.reasoning_details)
      result.reasoning = readReasoningDetails(c.message.reasoning_details);
    else if (c.message?.reasoning_content !== undefined)
      result.reasoning = [readReasoning(protocol, c.message.reasoning_content)];
    result.calls = (c.message?.tool_calls ?? []).map(call);
    result.usage = decodeUsage(protocol, data.usage) ?? result.usage;
    result.reason = reason(c.finish_reason);
  } else if (protocol === "openai-responses") {
    if (
      data.status &&
      !["completed", "incomplete", "failed"].includes(data.status)
    )
      throw new HostError(
        "upstream_protocol",
        "Upstream response is not complete",
        502,
      );
    if (data.status === "failed")
      throw new HostError("upstream_error", "Upstream response failed", 502);
    for (const item of data.output ?? []) {
      if (item.type === "message")
        for (const part of item.content ?? []) {
          if (part.type === "refusal")
            result.refusal =
              (result.refusal ?? "") + string(part.refusal, "refusal");
          else {
            const offset = result.text.length;
            result.text += text([part]);
            if (part.annotations?.length)
              (result.citations ??= []).push(
                ...readCitations(part.annotations, offset),
              );
          }
        }
      else if (item.type === "web_search_call")
        (result.searchCalls ??= []).push(
          readSearchCall({ ...item, status: item.status ?? "completed" }),
        );
      else if (item.type === "function_call") result.calls.push(call(item));
      else if (item.type === "reasoning") {
        const block = readReasoning(
          protocol,
          (item.summary ?? [])
            .map((p: any) => string(p.text, "reasoning summary"))
            .join(""),
          item.encrypted_content,
          { ...(item.id ? { id: item.id } : {}) },
        );
        if (block.source === protocol && block.signature) {
          block.encrypted = block.signature;
          delete block.signature;
        }
        (result.reasoning ??= []).push(block);
      } else unsupported("upstream output " + item.type);
    }
    result.usage = decodeUsage(protocol, data.usage) ?? result.usage;
    result.reason =
      data.status === "incomplete"
        ? data.incomplete_details?.reason === "content_filter"
          ? "content_filter"
          : "length"
        : result.calls.length
          ? "tool_calls"
          : "stop";
  } else if (protocol === "anthropic") {
    for (const b of data.content ?? []) {
      if (b.type === "text") result.text += b.text;
      else if (b.type === "tool_use")
        result.calls.push({
          id: b.id,
          name: b.name,
          arguments: JSON.stringify(b.input),
        });
      else if (b.type === "thinking")
        (result.reasoning ??= []).push(
          readReasoning(protocol, b.thinking, b.signature),
        );
      else if (b.type === "redacted_thinking")
        (result.reasoning ??= []).push(
          readReasoning(protocol, "", undefined, {
            redacted: string(b.data, "redacted thinking"),
          }),
        );
      else unsupported("upstream block " + b.type);
    }
    result.usage = decodeUsage(protocol, data.usage) ?? result.usage;
    result.reason = reason(data.stop_reason);
    if (data.stop_sequence)
      result.stopSequence = string(data.stop_sequence, "stop sequence");
  } else {
    const c = data.candidates?.[0];
    if (
      data.candidates?.length > 1 ||
      (c?.index !== undefined && c.index !== 0)
    )
      unsupported("multiple Gemini candidates");
    if (!c && data.promptFeedback?.blockReason) {
      result.reason = "content_filter";
      result.usage = decodeUsage(protocol, data.usageMetadata) ?? result.usage;
      return result;
    }
    if (!c)
      throw new HostError("upstream_protocol", "No Gemini candidate", 502);
    for (const part of c.content?.parts ?? []) {
      if (
        part.thought === true ||
        (part.thoughtSignature &&
          !part.functionCall &&
          (part.text === undefined || part.text === ""))
      ) {
        (result.reasoning ??= []).push(
          readReasoning(protocol, part.text ?? "", part.thoughtSignature),
        );
        continue;
      }
      if (part.text) {
        if (part.thoughtSignature) unsupported("signed visible Gemini text");
        result.text += part.text;
      } else if (part.functionCall)
        result.calls.push({
          id: part.functionCall.id ?? "call_" + randomUUID(),
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
          ...(part.thoughtSignature
            ? { thoughtSignature: part.thoughtSignature }
            : {}),
        });
      else unsupported("upstream Gemini part");
    }
    result.usage = decodeUsage(protocol, data.usageMetadata) ?? result.usage;
    const finish = reason(c.finishReason);
    result.reason =
      finish === "stop" && result.calls.length ? "tool_calls" : finish;
  }
  return result;
}
export function reason(value: any): AIResult["reason"] {
  if (
    [
      "content_filter",
      "refusal",
      "SAFETY",
      "RECITATION",
      "BLOCKLIST",
      "PROHIBITED_CONTENT",
      "SPII",
      "IMAGE_SAFETY",
    ].includes(value)
  )
    return "content_filter";
  if (
    ["MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL", "pause_turn"].includes(
      value,
    )
  )
    throw new HostError(
      "upstream_protocol",
      "Upstream stopped with an unsupported continuation or invalid tool call",
      502,
    );
  if (
    value !== undefined &&
    value !== null &&
    ![
      "stop",
      "end_turn",
      "stop_sequence",
      "STOP",
      "length",
      "max_tokens",
      "MAX_TOKENS",
      "tool_calls",
      "tool_use",
    ].includes(value)
  )
    throw new HostError(
      "upstream_protocol",
      "Unknown upstream finish reason",
      502,
    );
  return ["length", "max_tokens", "MAX_TOKENS"].includes(value)
    ? "length"
    : ["tool_calls", "tool_use"].includes(value)
      ? "tool_calls"
      : "stop";
}
export async function* resultEvents(result: AIResult): AsyncGenerator<AIEvent> {
  for (const [index, block] of (result.reasoning ?? []).entries())
    yield { type: "reasoning", index, ...block };
  for (const call of result.searchCalls ?? [])
    yield {
      type: "search",
      call: { ...call, status: call.status ?? "completed" },
    };
  if (result.refusal) yield { type: "refusal", text: result.refusal };
  if (result.text) yield { type: "text", text: result.text };
  for (const citation of result.citations ?? [])
    yield { type: "citation", citation };
  for (const [index, c] of result.calls.entries())
    yield { type: "tool", index, ...c, done: true };
  yield { type: "usage", usage: result.usage };
  yield {
    type: "finish",
    reason: result.reason,
    ...(result.stopSequence ? { stopSequence: result.stopSequence } : {}),
  };
}
export function appendEvent(out: AIResult, e: AIEvent) {
  if (e.type === "text") out.text += e.text;
  else if (e.type === "refusal") out.refusal = (out.refusal ?? "") + e.text;
  else if (e.type === "reasoning") {
    if (!Number.isSafeInteger(e.index) || e.index < 0 || e.index > 127)
      throw new HostError("upstream_protocol", "Invalid reasoning index", 502);
    const blocks = (out.reasoning ??= []),
      b = blocks[e.index] ?? { source: e.source, text: "" };
    if (b.source !== e.source)
      throw new HostError("upstream_protocol", "Reasoning source changed", 502);
    b.text += e.text;
    if (e.signature) b.signature = (b.signature ?? "") + e.signature;
    if (e.encrypted) b.encrypted = e.encrypted;
    if (e.redacted) b.redacted = e.redacted;
    if (e.id) b.id = e.id;
    blocks[e.index] = b;
  } else if (e.type === "tool") {
    if (!Number.isSafeInteger(e.index) || e.index < 0 || e.index > 1023)
      throw new HostError("upstream_protocol", "Invalid tool index", 502);
    const c = out.calls[e.index] ?? {
      id: e.id ?? "call_" + randomUUID(),
      name: "",
      arguments: "",
    };
    if (e.id) c.id = e.id;
    if (e.name) c.name += e.name;
    if (e.arguments) c.arguments += e.arguments;
    if (e.thoughtSignature) c.thoughtSignature = e.thoughtSignature;
    if (e.done && !c.arguments) c.arguments = "{}";
    out.calls[e.index] = c;
  } else if (e.type === "search") {
    const calls = (out.searchCalls ??= []);
    const index = calls.findIndex((call) => call.id === e.call.id);
    if (index < 0) calls.push(e.call);
    else calls[index] = { ...calls[index], ...e.call };
  } else if (e.type === "citation") {
    const citations = (out.citations ??= []);
    if (
      !citations.some(
        (citation) => JSON.stringify(citation) === JSON.stringify(e.citation),
      )
    )
      citations.push(e.citation);
  } else if (e.type === "usage") out.usage = e.usage;
  else if (e.type === "finish") {
    out.reason = e.reason;
    if (e.stopSequence) out.stopSequence = e.stopSequence;
  }
  const size =
    out.text.length +
    (out.searchCalls ? JSON.stringify(out.searchCalls).length : 0) +
    (out.citations ? JSON.stringify(out.citations).length : 0) +
    (out.refusal?.length ?? 0) +
    out.calls.reduce((n, c) => n + c.arguments.length + c.name.length, 0) +
    (out.reasoning ?? []).reduce(
      (n, b) =>
        n +
        b.text.length +
        (b.signature?.length ?? 0) +
        (b.encrypted?.length ?? 0) +
        (b.redacted?.length ?? 0),
      0,
    );
  if (size > 16 * 1024 * 1024)
    throw new HostError(
      "response_too_large",
      "Response exceeds aggregation limit",
      502,
    );
}
export async function collect(
  events: AsyncIterable<AIEvent>,
  model: string,
): Promise<AIResult> {
  const out: AIResult = {
    id: "resp_" + randomUUID(),
    model,
    text: "",
    calls: [],
    usage: { input: 0, output: 0 },
    reason: "stop",
  };
  for await (const e of events) {
    appendEvent(out, e);
  }
  out.calls = out.calls.filter(Boolean);
  if (out.reasoning) out.reasoning = out.reasoning.filter(Boolean);
  for (const c of out.calls) {
    try {
      requiredString(c.id, "tool ID");
      requiredString(c.name, "tool name");
      parseArgs(c.arguments || "{}");
      c.arguments ||= "{}";
    } catch {
      throw new HostError(
        "upstream_protocol",
        "Invalid completed tool call",
        502,
      );
    }
  }
  return out;
}
