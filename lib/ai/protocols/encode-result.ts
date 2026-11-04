import { randomUUID } from "node:crypto";
import type { AIResult, Protocol, ReasoningContent } from "@pluhub/contracts/ai";
import { packReasoning } from "../content.js";
import { encodeUsage } from "../usage.js";
import { writeCitations } from "../web-search.js";
import { parseArgs, unsupported } from "./helpers.js";

export function encodeResult(protocol: Protocol, r: AIResult): any {
  if (
    !["openai-chat", "openai-responses"].includes(protocol) &&
    (r.searchCalls?.length || r.citations?.length)
  )
    unsupported("web search results in " + protocol);
  r = {
    ...r,
    calls: r.calls.filter(Boolean),
    ...(r.reasoning ? { reasoning: r.reasoning.filter(Boolean) } : {}),
  };
  if (protocol === "anthropic" && r.calls.some((c) => c?.thoughtSignature))
    unsupported("Gemini tool signature in Anthropic output");
  if (protocol === "openai-chat")
    return {
      id: r.id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: r.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: r.text || null,
            ...(r.citations?.length
              ? { annotations: writeCitations(r.citations, true) }
              : {}),
            ...(r.searchCalls?.length
              ? { extra_content: { web_search_calls: r.searchCalls } }
              : {}),
            ...(r.reasoning?.length
              ? {
                  reasoning_content: r.reasoning.map((b) => b.text).join(""),
                  reasoning_details: r.reasoning.map((b, index) => ({
                    type:
                      b.encrypted || b.redacted
                        ? "reasoning.encrypted"
                        : "reasoning.text",
                    format: b.source,
                    index,
                    text: b.text,
                    ...(b.signature ? { signature: b.signature } : {}),
                    ...(b.encrypted || b.redacted
                      ? { data: b.encrypted ?? b.redacted }
                      : {}),
                    ...(b.id ? { id: b.id } : {}),
                  })),
                }
              : {}),
            ...(r.refusal !== undefined ? { refusal: r.refusal } : {}),
            ...(r.calls.length
              ? {
                  tool_calls: r.calls.map((c) => ({
                    id: c.id,
                    type: "function",
                    function: { name: c.name, arguments: c.arguments },
                    ...(c.thoughtSignature
                      ? {
                          extra_content: {
                            google: { thought_signature: c.thoughtSignature },
                          },
                        }
                      : {}),
                  })),
                }
              : {}),
          },
          finish_reason: r.reason,
        },
      ],
      usage: encodeUsage(protocol, r.usage),
    };
  if (protocol === "openai-responses")
    return {
      id: r.id,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status:
        r.reason === "length" || r.reason === "content_filter"
          ? "incomplete"
          : "completed",
      model: r.model,
      output: [
        ...(r.reasoning ?? []).map((b) => reasoningPart(protocol, b)),
        ...(r.searchCalls ?? []),
        ...(r.text
          ? [
              {
                type: "message",
                id: "msg_" + r.id,
                status: "completed",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: r.text,
                    annotations: writeCitations(r.citations),
                  },
                ],
              },
            ]
          : []),
        ...(r.refusal
          ? [
              {
                type: "message",
                id: "refusal_" + r.id,
                role: "assistant",
                status: "completed",
                content: [{ type: "refusal", refusal: r.refusal }],
              },
            ]
          : []),
        ...r.calls.map((c) => ({
          type: "function_call",
          id: "fc_" + c.id,
          call_id: c.id,
          name: c.name,
          arguments: c.arguments,
          status: "completed",
          ...(c.thoughtSignature
            ? {
                extra_content: {
                  google: { thought_signature: c.thoughtSignature },
                },
              }
            : {}),
        })),
      ],
      usage: encodeUsage(protocol, r.usage),
      ...(r.reason === "length" || r.reason === "content_filter"
        ? {
            incomplete_details: {
              reason:
                r.reason === "length" ? "max_output_tokens" : "content_filter",
            },
          }
        : {}),
    };
  if (protocol === "anthropic")
    return {
      id: r.id,
      type: "message",
      role: "assistant",
      model: r.model,
      content: [
        ...(r.reasoning ?? []).map((b) => reasoningPart(protocol, b)),
        ...(r.text ? [{ type: "text", text: r.text }] : []),
        ...(r.refusal ? [{ type: "text", text: r.refusal }] : []),
        ...r.calls.map((c) => ({
          type: "tool_use",
          id: c.id,
          name: c.name,
          input: parseArgs(c.arguments),
        })),
      ],
      stop_reason:
        r.reason === "length"
          ? "max_tokens"
          : r.reason === "tool_calls"
            ? "tool_use"
            : r.reason === "content_filter"
              ? "refusal"
              : r.stopSequence
                ? "stop_sequence"
                : "end_turn",
      stop_sequence: r.stopSequence ?? null,
      usage: encodeUsage(protocol, r.usage),
    };
  return {
    candidates: [
      {
        index: 0,
        content: {
          role: "model",
          parts: [
            ...(r.reasoning ?? []).map((b) => reasoningPart(protocol, b)),
            ...(r.text ? [{ text: r.text }] : []),
            ...(r.refusal ? [{ text: r.refusal }] : []),
            ...r.calls.map((c) => ({
              functionCall: {
                id: c.id,
                name: c.name,
                args: parseArgs(c.arguments),
              },
              ...(c.thoughtSignature
                ? { thoughtSignature: c.thoughtSignature }
                : {}),
            })),
          ],
        },
        finishReason:
          r.reason === "length"
            ? "MAX_TOKENS"
            : r.reason === "content_filter"
              ? "SAFETY"
              : "STOP",
      },
    ],
    usageMetadata: encodeUsage(protocol, r.usage),
    modelVersion: r.model,
  };
}
export function reasoningPart(protocol: Protocol, b: ReasoningContent): any {
  const signature = packReasoning(b, protocol);
  if (protocol === "openai-responses")
    return {
      id: b.id ?? "rs_" + randomUUID(),
      type: "reasoning",
      summary: b.text ? [{ type: "summary_text", text: b.text }] : [],
      ...(signature ? { encrypted_content: signature } : {}),
    };
  if (protocol === "anthropic")
    return b.source === protocol && b.redacted
      ? { type: "redacted_thinking", data: b.redacted }
      : {
          type: "thinking",
          thinking: b.text,
          ...(signature ? { signature } : {}),
        };
  return {
    text: b.text,
    thought: true,
    ...(signature ? { thoughtSignature: signature } : {}),
  };
}
export function protocolError(protocol: Protocol, error: unknown): Response {
  const e = error as any;
  const status =
    Number.isInteger(e?.status) && e.status >= 400 && e.status <= 599
      ? e.status
      : 500;
  const message =
    status < 500 && typeof e?.message === "string"
      ? e.message
      : "Upstream request failed";
  const kind =
    status === 400 || status === 422
      ? "invalid_request_error"
      : status === 401
        ? "authentication_error"
        : status === 403
          ? "permission_error"
          : status === 404
            ? "not_found_error"
            : status === 429
              ? "rate_limit_error"
              : status === 529
                ? "overloaded_error"
                : "api_error";
  return Response.json(
    protocol === "anthropic"
      ? { type: "error", error: { type: kind, message } }
      : protocol === "gemini"
        ? {
            error: {
              code: status,
              message,
              status:
                status === 400 || status === 422
                  ? "INVALID_ARGUMENT"
                  : status === 401
                    ? "UNAUTHENTICATED"
                    : status === 403
                      ? "PERMISSION_DENIED"
                      : status === 404
                        ? "NOT_FOUND"
                        : status === 429
                          ? "RESOURCE_EXHAUSTED"
                          : status === 503 || status === 502 || status === 529
                            ? "UNAVAILABLE"
                            : "INTERNAL",
            },
          }
        : {
            error: {
              type: kind,
              code: typeof e?.code === "string" ? e.code : "api_error",
              message,
            },
          },
    { status },
  );
}

