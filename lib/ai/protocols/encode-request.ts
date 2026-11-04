import { HostError } from "@pluhub/sdk";
import type { AIRequest, Protocol } from "@pluhub/contracts/ai";
import { assertReasoningTarget, writeContent } from "../content.js";
import { encodeReasoning } from "../reasoning.js";
import { writeOptions } from "../request-options.js";
import { validateWebSearchTarget } from "../web-search.js";
import { mergeMessages, parseArgs, reasoningHistory, tryJSON, unsupported } from "./helpers.js";

export function encodeRequest(protocol: Protocol, request: AIRequest): any {
  validateWebSearchTarget(request, protocol);
  const { messages, tools, model, stream, maxTokens, temperature } = request;
  const options: Record<string, any> = {
    ...(temperature !== undefined ? { temperature } : {}),
    ...(protocol !== "gemini"
      ? encodeReasoning(protocol, request.reasoning)
      : {}),
  };
  const extra = writeOptions(protocol, request);
  if (request.sessionId) {
    if (protocol === "openai-chat" || protocol === "openai-responses")
      extra.prompt_cache_key = request.sessionId;
    else if (protocol === "anthropic")
      extra.metadata = {
        user_id: JSON.stringify({ session_id: request.sessionId }),
      };
  }
  for (const m of messages)
    for (const c of m.calls ?? []) parseArgs(c.arguments);
  if (
    protocol === "anthropic" &&
    maxTokens !== undefined &&
    request.reasoning?.budgetTokens !== undefined &&
    request.reasoning.budgetTokens >= maxTokens
  )
    throw new HostError(
      "invalid_reasoning",
      "Thinking budget must be smaller than max_tokens",
    );
  if (options.output_config && extra.output_config)
    extra.output_config = { ...options.output_config, ...extra.output_config };
  if (protocol === "openai-chat")
    return {
      model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content
          ? writeContent(protocol, m)
          : m.toolError
            ? JSON.stringify({ error: m.text })
            : m.role === "tool"
              ? m.text
              : m.text || null,
        ...(m.refusal !== undefined ? { refusal: m.refusal } : {}),
        ...(m.reasoning?.length
          ? (() => {
              m.reasoning.forEach((b) => assertReasoningTarget(b, protocol));
              return {
                reasoning_content: m.reasoning.map((b) => b.text).join(""),
                reasoning_details: m.reasoning.map((b, index) => ({
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
              };
            })()
          : {}),
        ...(m.calls
          ? {
              tool_calls: m.calls.map((c) => ({
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
        ...(m.callId ? { tool_call_id: m.callId } : {}),
      })),
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(request.webSearch
        ? { web_search_options: request.webSearch.options }
        : {}),
      ...(tools.length
        ? { tools: tools.map((t) => ({ type: "function", function: t })) }
        : {}),
      ...(maxTokens ? { max_completion_tokens: maxTokens } : {}),
      ...options,
      ...extra,
    };
  if (protocol === "openai-responses")
    return {
      model,
      store: false,
      input: messages.flatMap<any>((m) =>
        m.role === "tool"
          ? [
              {
                type: "function_call_output",
                call_id: m.callId,
                output: m.content
                  ? unsupported("multimodal tool output in Responses")
                  : m.toolError
                    ? JSON.stringify({ error: m.text })
                    : m.text,
              },
            ]
          : [
              ...(m.searchCalls ?? []),
              ...reasoningHistory(protocol, m),
              ...(m.text || m.content
                ? [{ role: m.role, content: writeContent(protocol, m) }]
                : []),
              ...(m.refusal
                ? [
                    {
                      role: "assistant",
                      content: [{ type: "refusal", refusal: m.refusal }],
                    },
                  ]
                : []),
              ...(m.calls ?? []).map((c) => ({
                type: "function_call",
                call_id: c.id,
                name: c.name,
                arguments: c.arguments,
                ...(c.thoughtSignature
                  ? {
                      extra_content: {
                        google: { thought_signature: c.thoughtSignature },
                      },
                    }
                  : {}),
              })),
            ],
      ),
      stream,
      ...(tools.length || request.webSearch
        ? {
            tools: [
              ...tools.map((t) => ({ type: "function", ...t })),
              ...(request.webSearch
                ? [
                    {
                      type: request.webSearch.type,
                      ...request.webSearch.options,
                    },
                  ]
                : []),
            ],
          }
        : {}),
      ...(maxTokens ? { max_output_tokens: maxTokens } : {}),
      ...options,
      ...extra,
      ...(request.webSearch?.choice
        ? { tool_choice: { type: request.webSearch.choice } }
        : {}),
      ...(request.webSearch?.maxCalls !== undefined
        ? { max_tool_calls: request.webSearch.maxCalls }
        : {}),
      ...(request.webSearch?.includeSources
        ? {
            include: [
              ...(options.include ?? []),
              "web_search_call.action.sources",
            ],
          }
        : {}),
    };
  if (protocol === "anthropic")
    return {
      model,
      max_tokens:
        maxTokens ??
        Math.max(1024, (request.reasoning?.budgetTokens ?? 0) + 1024),
      stream,
      system: messages
        .filter((m) => m.role === "system" || m.role === "developer")
        .map((m) => m.text)
        .join("\n"),
      messages: mergeMessages(
        messages
          .filter((m) => m.role !== "system" && m.role !== "developer")
          .map((m) => ({
            role: m.role === "tool" ? "user" : m.role,
            content:
              m.role === "tool"
                ? [
                    {
                      type: "tool_result",
                      tool_use_id: m.callId,
                      content: writeContent(protocol, m),
                      ...(m.toolError !== undefined
                        ? { is_error: m.toolError }
                        : {}),
                    },
                  ]
                : [
                    ...reasoningHistory(protocol, m),
                    ...(m.content
                      ? writeContent(protocol, m)
                      : m.text
                        ? [{ type: "text", text: m.text }]
                        : []),
                    ...(m.refusal ? [{ type: "text", text: m.refusal }] : []),
                    ...(m.calls ?? []).map((c) => ({
                      type: "tool_use",
                      id: c.id,
                      name: c.name,
                      input: parseArgs(c.arguments),
                      ...(c.thoughtSignature
                        ? unsupported(
                            "Gemini tool signature cannot be represented in Anthropic",
                          )
                        : {}),
                    })),
                  ],
          })),
        "content",
      ),
      ...(tools.length
        ? {
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
              ...(t.strict !== undefined ? { strict: t.strict } : {}),
            })),
          }
        : {}),
      ...options,
      ...extra,
    };
  const names = new Map(
    messages.flatMap((m) =>
      (m.calls ?? []).map((c) => [c.id, c.name] as const),
    ),
  );
  return {
    ...(messages.some((m) => m.role === "system" || m.role === "developer")
      ? {
          systemInstruction: {
            parts: [
              {
                text: messages
                  .filter((m) => m.role === "system" || m.role === "developer")
                  .map((m) => m.text)
                  .join("\n"),
              },
            ],
          },
        }
      : {}),
    contents: mergeMessages(
      messages
        .filter((m) => m.role !== "system" && m.role !== "developer")
        .map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts:
            m.role === "tool"
              ? [
                  {
                    functionResponse: {
                      name:
                        m.toolName ??
                        names.get(m.callId!) ??
                        unsupported("unmatched tool result"),
                      id: m.callId,
                      response: m.toolError
                        ? { error: m.text }
                        : m.content
                          ? unsupported("multimodal Gemini tool output")
                          : tryJSON(m.text),
                    },
                  },
                ]
              : [
                  ...reasoningHistory(protocol, m),
                  ...(m.text || m.content ? writeContent(protocol, m) : []),
                  ...(m.refusal ? [{ text: m.refusal }] : []),
                  ...(m.calls ?? []).map((c) => ({
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
        })),
      "parts",
    ),
    ...(tools.length
      ? {
          tools: [
            {
              functionDeclarations: tools.map((t) => ({
                name: t.name,
                description: t.description,
                parametersJsonSchema: t.parameters,
              })),
            },
          ],
        }
      : {}),
    generationConfig: {
      ...(maxTokens ? { maxOutputTokens: maxTokens } : {}),
      ...options,
      ...encodeReasoning(protocol, request.reasoning),
      ...Object.fromEntries(
        Object.entries(extra).filter(([k]) => k !== "toolConfig"),
      ),
    },
    ...(extra.toolConfig ? { toolConfig: extra.toolConfig } : {}),
  };
}
