import { writeCitations } from "./web-search.js";
import { randomUUID } from "node:crypto";
import { HostError } from "@pluhub/sdk";
import type { AIEvent, AIResult, Protocol } from "@pluhub/contracts/ai";
import { appendEvent, encodeResult, reasoningPart } from "./protocols.js";
import { encodeUsage } from "./usage.js";
import { packReasoning, unsupported } from "./content.js";
import { streamError } from "./stream-error.js";
export const frame = (data: any, event?: string) =>
  (event ? "event: " + event + "\n" : "") +
  "data: " +
  JSON.stringify(data) +
  "\n\n";
export async function* wire(
  protocol: Protocol,
  events: AsyncIterable<AIEvent>,
  model: string,
  onError?: (error: unknown) => void,
): AsyncGenerator<string> {
  const r: AIResult = {
    id: "resp_" + randomUUID(),
    model,
    text: "",
    calls: [],
    usage: { input: 0, output: 0 },
    reason: "stop",
  };
  const created = Math.floor(Date.now() / 1000);
  let sequence = 0,
    usageKnown = false,
    finished = false;
  const base = {
    id: r.id,
    object: "response",
    created_at: created,
    model,
    status: "in_progress",
    output: [],
  };
  const response = (type: string, data: any) =>
    frame({ type, sequence_number: sequence++, ...data }, type);
  const chat = (delta: any, finish_reason: any = null, usage?: any) =>
    frame({
      id: r.id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: usage ? [] : [{ index: 0, delta, finish_reason }],
      ...(usage ? { usage } : {}),
    });
  const items: { key: string; index: number; item: any }[] = [];
  function* item(key: string, value: any): Generator<string> {
    if (items.some((i) => i.key === key)) return;
    const index = items.length;
    items.push({ key, index, item: value });
    yield response("response.output_item.added", {
      output_index: index,
      item: value,
    });
    if (key === "text" || key === "refusal")
      yield response("response.content_part.added", {
        item_id: value.id,
        output_index: index,
        content_index: 0,
        part:
          key === "text"
            ? { type: "output_text", text: "", annotations: [] }
            : { type: "refusal", refusal: "" },
      });
    if (key.startsWith("reason:"))
      yield response("response.reasoning_summary_part.added", {
        item_id: value.id,
        output_index: index,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      });
  }
  let blockCount = 0,
    block: { key: string; index: number; kind: string } | undefined;
  const closedReasoning = new Set<string>();
  const completedSearches = new Set<string>();
  const searchPhases = new Set<string>();
  function* closeBlock(): Generator<string> {
    if (!block) return;
    if (block.kind === "thinking") {
      const b = r.reasoning![Number(block.key.slice(7))]!;
      const signature = packReasoning(b, protocol);
      if (signature)
        yield frame(
          {
            type: "content_block_delta",
            index: block.index,
            delta: { type: "signature_delta", signature },
          },
          "content_block_delta",
        );
      closedReasoning.add(block.key);
    }
    yield frame(
      { type: "content_block_stop", index: block.index },
      "content_block_stop",
    );
    block = undefined;
  }
  function* openBlock(key: string, value: any): Generator<string> {
    if (block?.key === key) return;
    yield* closeBlock();
    block = { key, index: blockCount++, kind: value.type };
    yield frame(
      { type: "content_block_start", index: block.index, content_block: value },
      "content_block_start",
    );
  }
  const toolState = new Map<
    number,
    {
      started: boolean;
      emitted: number;
      name?: string;
      id?: string;
      done: boolean;
    }
  >();
  function* tool(index: number, done: boolean): Generator<string> {
    const call = r.calls[index]!;
    const state = toolState.get(index) ?? {
      started: false,
      emitted: 0,
      done: false,
    };
    toolState.set(index, state);
    if (state.done) return;
    if (!call.name || (!call.arguments && !done)) return;
    if (state.started && (state.name !== call.name || state.id !== call.id))
      throw new HostError(
        "upstream_protocol",
        "Tool metadata changed after argument delivery",
        502,
      );
    if (done) {
      try {
        const parsed = JSON.parse(call.arguments || "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error();
      } catch {
        throw new HostError(
          "upstream_protocol",
          "Incomplete or invalid tool arguments",
          502,
        );
      }
    }
    if (protocol === "anthropic" || protocol === "gemini") {
      if (!done) return;
      if (protocol === "anthropic") {
        if (call.thoughtSignature)
          unsupported("Gemini tool signature in Anthropic stream");
        yield* openBlock("tool:" + index, {
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: {},
        });
        yield frame(
          {
            type: "content_block_delta",
            index: block!.index,
            delta: {
              type: "input_json_delta",
              partial_json: call.arguments || "{}",
            },
          },
          "content_block_delta",
        );
        yield* closeBlock();
      } else
        yield frame({
          candidates: [
            {
              index: 0,
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: {
                      id: call.id,
                      name: call.name,
                      args: JSON.parse(call.arguments || "{}"),
                    },
                    ...(call.thoughtSignature
                      ? { thoughtSignature: call.thoughtSignature }
                      : {}),
                  },
                ],
              },
            },
          ],
        });
    } else {
      const delta = call.arguments.slice(state.emitted);
      if (protocol === "openai-chat") {
        if (!state.started || delta || call.thoughtSignature)
          yield chat({
            tool_calls: [
              {
                index,
                ...(!state.started ? { id: call.id, type: "function" } : {}),
                function: {
                  ...(!state.started ? { name: call.name } : {}),
                  ...(delta ? { arguments: delta } : {}),
                },
                ...(call.thoughtSignature
                  ? {
                      extra_content: {
                        google: { thought_signature: call.thoughtSignature },
                      },
                    }
                  : {}),
              },
            ],
          });
      } else {
        yield* item("tool:" + index, {
          id: "fc_" + call.id,
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: "",
          status: "in_progress",
        });
        const entry = items.find((i) => i.key === "tool:" + index)!;
        if (delta)
          yield response("response.function_call_arguments.delta", {
            item_id: entry.item.id,
            output_index: entry.index,
            delta,
          });
        if (done) {
          entry.item = {
            ...entry.item,
            arguments: call.arguments || "{}",
            status: "completed",
            ...(call.thoughtSignature
              ? {
                  extra_content: {
                    google: { thought_signature: call.thoughtSignature },
                  },
                }
              : {}),
          };
          yield response("response.function_call_arguments.done", {
            item_id: entry.item.id,
            output_index: entry.index,
            arguments: entry.item.arguments,
          });
          yield response("response.output_item.done", {
            output_index: entry.index,
            item: entry.item,
          });
        }
      }
    }
    state.started = true;
    state.name = call.name;
    state.id = call.id;
    state.emitted = call.arguments.length;
    state.done = done;
  }
  if (protocol === "openai-chat")
    yield chat({ role: "assistant", content: "" });
  else if (protocol === "openai-responses") {
    yield response("response.created", { response: base });
    yield response("response.in_progress", { response: base });
  } else if (protocol === "anthropic")
    yield frame(
      {
        type: "message_start",
        message: {
          id: r.id,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
      "message_start",
    );
  try {
    for await (const e of events) {
      if (finished)
        throw new HostError(
          "upstream_protocol",
          "Events after terminal event",
          502,
        );
      if (
        e.type === "tool" &&
        toolState.get(e.index)?.done &&
        (e.name || e.arguments || e.id || e.thoughtSignature)
      )
        throw new HostError(
          "upstream_protocol",
          "Tool data after completion",
          502,
        );
      appendEvent(r, e);
      if (e.type === "search") {
        if (protocol === "openai-responses") {
          const key = "search:" + e.call.id;
          yield* item(key, { ...e.call, status: "in_progress" });
          const entry = items.find((item) => item.key === key)!;
          entry.item = { ...entry.item, ...e.call };
          const phase =
            e.phase ??
            (e.call.status === "completed" ? "completed" : undefined);
          if (phase && !searchPhases.has(key + ":" + phase)) {
            searchPhases.add(key + ":" + phase);
            yield response("response.web_search_call." + phase, {
              item_id: entry.item.id,
              output_index: entry.index,
            });
          }
          if (
            !e.phase &&
            ["completed", "failed", "incomplete"].includes(
              String(e.call.status),
            ) &&
            !completedSearches.has(key)
          ) {
            completedSearches.add(key);
            yield response("response.output_item.done", {
              output_index: entry.index,
              item: entry.item,
            });
          }
        } else if (protocol === "openai-chat")
          yield chat({ extra_content: { web_search_calls: [e.call] } });
        else unsupported("web search output in " + protocol);
      } else if (e.type === "citation") {
        if (protocol === "openai-chat")
          yield chat({ annotations: writeCitations([e.citation], true) });
        else if (protocol === "openai-responses") {
          const entry = items.find((item) => item.key === "text");
          if (!entry)
            throw new HostError(
              "upstream_protocol",
              "Citation before response text",
              502,
            );
          yield response("response.output_text.annotation.added", {
            item_id: entry.item.id,
            output_index: entry.index,
            content_index: 0,
            annotation_index: r.citations!.findIndex(
              (citation) =>
                JSON.stringify(citation) === JSON.stringify(e.citation),
            ),
            annotation: writeCitations([e.citation])[0],
          });
        } else unsupported("citations in " + protocol);
      } else if (e.type === "text" || e.type === "refusal") {
        const refusal = e.type === "refusal",
          key = refusal ? "refusal" : "text";
        if (protocol === "openai-chat")
          yield chat(refusal ? { refusal: e.text } : { content: e.text });
        else if (protocol === "openai-responses") {
          yield* item(key, {
            id: key + "_" + r.id,
            type: "message",
            role: "assistant",
            status: "in_progress",
            content: [],
          });
          const entry = items.find((i) => i.key === key)!;
          yield response(
            refusal ? "response.refusal.delta" : "response.output_text.delta",
            {
              item_id: entry.item.id,
              output_index: entry.index,
              content_index: 0,
              delta: e.text,
            },
          );
        } else if (protocol === "anthropic") {
          yield* openBlock(key, { type: "text", text: "" });
          yield frame(
            {
              type: "content_block_delta",
              index: block!.index,
              delta: { type: "text_delta", text: e.text },
            },
            "content_block_delta",
          );
        } else
          yield frame({
            candidates: [
              {
                index: 0,
                content: { role: "model", parts: [{ text: e.text }] },
              },
            ],
          });
      } else if (e.type === "reasoning") {
        const key = "reason:" + e.index,
          b = r.reasoning![e.index]!;
        if (protocol === "openai-chat")
          yield chat({
            ...(e.text ? { reasoning_content: e.text } : {}),
            reasoning_details: [
              {
                type:
                  e.encrypted || e.redacted
                    ? "reasoning.encrypted"
                    : "reasoning.text",
                format: e.source,
                index: e.index,
                text: e.text,
                ...(e.signature ? { signature: e.signature } : {}),
                ...(e.encrypted || e.redacted
                  ? { data: e.encrypted ?? e.redacted }
                  : {}),
                ...(e.id ? { id: e.id } : {}),
              },
            ],
          });
        else if (protocol === "openai-responses") {
          yield* item(key, {
            id: b.id ?? "rs_" + e.index + "_" + r.id,
            type: "reasoning",
            summary: [],
          });
          const entry = items.find((i) => i.key === key)!;
          if (e.text)
            yield response("response.reasoning_summary_text.delta", {
              item_id: entry.item.id,
              output_index: entry.index,
              summary_index: 0,
              delta: e.text,
            });
        } else if (protocol === "anthropic") {
          if (closedReasoning.has(key))
            throw new HostError(
              "upstream_protocol",
              "Reasoning signature arrived after its content block closed",
              502,
            );
          if (b.redacted && b.source === "anthropic") {
            yield* openBlock(key, {
              type: "redacted_thinking",
              data: b.redacted,
            });
            yield* closeBlock();
          } else {
            yield* openBlock(key, { type: "thinking", thinking: "" });
            if (e.text)
              yield frame(
                {
                  type: "content_block_delta",
                  index: block!.index,
                  delta: { type: "thinking_delta", thinking: e.text },
                },
                "content_block_delta",
              );
          }
        } else
          yield frame({
            candidates: [
              {
                index: 0,
                content: {
                  role: "model",
                  parts: [
                    {
                      text: e.text,
                      thought: true,
                      ...(e.source !== protocol ||
                      e.signature ||
                      e.encrypted ||
                      e.redacted
                        ? {
                            thoughtSignature: packReasoning({ ...e }, protocol),
                          }
                        : {}),
                    },
                  ],
                },
              },
            ],
          });
      } else if (e.type === "tool") yield* tool(e.index, !!e.done);
      else if (e.type === "usage") usageKnown = true;
      else if (e.type === "media")
        unsupported("media output in a conversational endpoint");
      else if (e.type === "finish") {
        for (let index = 0; index < r.calls.length; index++)
          if (r.calls[index]) yield* tool(index, true);
        finished = true;
      }
    }
    if (!finished)
      throw new HostError(
        "upstream_truncated",
        "Upstream stream ended before completion",
        502,
      );
    if (protocol === "openai-chat") {
      yield chat({}, r.reason);
      if (usageKnown) yield chat({}, null, encodeUsage(protocol, r.usage));
      yield "data: [DONE]\n\n";
    } else if (protocol === "openai-responses") {
      for (const entry of items) {
        if (entry.key.startsWith("tool:") || entry.key.startsWith("search:"))
          continue;
        if (entry.key.startsWith("reason:")) {
          const b = r.reasoning![Number(entry.key.slice(7))]!;
          entry.item = { ...reasoningPart(protocol, b), id: entry.item.id };
          yield response("response.reasoning_summary_text.done", {
            item_id: entry.item.id,
            output_index: entry.index,
            summary_index: 0,
            text: b.text,
          });
          yield response("response.reasoning_summary_part.done", {
            item_id: entry.item.id,
            output_index: entry.index,
            summary_index: 0,
            part: { type: "summary_text", text: b.text },
          });
        } else {
          const refusal = entry.key === "refusal",
            text = refusal ? r.refusal! : r.text;
          const part = refusal
            ? { type: "refusal", refusal: text }
            : {
                type: "output_text",
                text,
                annotations: writeCitations(r.citations),
              };
          entry.item = { ...entry.item, status: "completed", content: [part] };
          yield response(
            refusal ? "response.refusal.done" : "response.output_text.done",
            {
              item_id: entry.item.id,
              output_index: entry.index,
              content_index: 0,
              ...(refusal ? { refusal: text } : { text }),
            },
          );
          yield response("response.content_part.done", {
            item_id: entry.item.id,
            output_index: entry.index,
            content_index: 0,
            part,
          });
        }
        yield response("response.output_item.done", {
          output_index: entry.index,
          item: entry.item,
        });
      }
      const final = encodeResult(protocol, {
        ...r,
        calls: r.calls.filter(Boolean),
      });
      final.created_at = created;
      final.output = items.map((i) => i.item);
      if (!usageKnown) delete final.usage;
      yield response(
        final.status === "incomplete"
          ? "response.incomplete"
          : "response.completed",
        { response: final },
      );
    } else if (protocol === "anthropic") {
      yield* closeBlock();
      yield frame(
        {
          type: "message_delta",
          delta: {
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
          },
          ...(usageKnown ? { usage: encodeUsage(protocol, r.usage) } : {}),
        },
        "message_delta",
      );
      yield frame({ type: "message_stop" }, "message_stop");
    } else
      yield frame({
        candidates: [
          {
            index: 0,
            content: { role: "model", parts: [] },
            finishReason:
              r.reason === "length"
                ? "MAX_TOKENS"
                : r.reason === "content_filter"
                  ? "SAFETY"
                  : "STOP",
          },
        ],
        ...(usageKnown
          ? { usageMetadata: encodeUsage(protocol, r.usage) }
          : {}),
        modelVersion: model,
      });
  } catch (error) {
    onError?.(error);
    const safe = streamError(error);
    if (protocol === "openai-responses")
      yield response("response.failed", {
        response: {
          ...base,
          status: "failed",
          error: safe,
        },
      });
    else if (protocol === "anthropic")
      yield frame(
        {
          type: "error",
          error: {
            type: "api_error",
            message: safe.message,
            ...(safe.code === "upstream_budget_exceeded"
              ? { code: safe.code }
              : {}),
          },
        },
        "error",
      );
    else if (protocol === "gemini")
      yield frame({
        error: {
          code: 502,
          message: safe.message,
          status: "UNAVAILABLE",
          ...(safe.code === "upstream_budget_exceeded"
            ? {
                details: [
                  {
                    "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                    reason: safe.code,
                    domain: "pluhub",
                  },
                ],
              }
            : {}),
        },
      });
    else
      yield frame({
        error: {
          type: "api_error",
          code: safe.code,
          message: safe.message,
        },
      });
  }
}
