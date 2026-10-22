import { randomUUID } from "node:crypto";
import { HostError } from "@pluhub/sdk";
import type {
  AIEvent,
  Protocol,
  ReasoningContent,
  FinishReason,
} from "@pluhub/contracts/ai";
import { parseSSE, reason } from "./protocols.js";
import { readReasoning } from "./content.js";
import { decodeUsage } from "./usage.js";
const bad = (message: string): never => {
  throw new HostError("upstream_protocol", message, 502);
};
const str = (v: any, name: string) =>
  typeof v === "string" && v.length <= 1048576
    ? v
    : bad("Invalid upstream " + name);
export async function* decodeEvents(
  protocol: Protocol,
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<AIEvent> {
  let terminal = false,
    finish: FinishReason = "stop",
    stopSequence: string | undefined;
  const toolKeys = new Map<any, number>(),
    tools = new Map<
      number,
      {
        id: string;
        name: string;
        args: string;
        done: boolean;
        signature?: string;
      }
    >();
  const reasonKeys = new Map<any, number>(),
    reasoning = new Map<number, ReasoningContent & { sent: boolean }>();
  const sentText = new Map<any, string>(),
    sentRefusal = new Map<any, string>();
  let anthropicUsage: any,
    toolSerial = 0,
    geminiReasonSerial = 0;
  let geminiReason: string | undefined;
  const initialInputs = new Map<any, any>();
  function toolIndex(key: any) {
    if (!toolKeys.has(key)) {
      if (toolKeys.size >= 1024) bad("Too many upstream tools");
      toolKeys.set(key, toolKeys.size);
    }
    return toolKeys.get(key)!;
  }
  function* tool(
    key: any,
    data: { id?: any; name?: any; args?: any; signature?: any },
  ): Generator<AIEvent> {
    const index = toolIndex(key),
      current = tools.get(index) ?? {
        id: "call_" + randomUUID(),
        name: "",
        args: "",
        done: false,
      };
    if (current.done) return bad("Tool data after its completion");
    if (data.id !== undefined) current.id = str(data.id, "tool ID");
    if (data.name !== undefined) current.name += str(data.name, "tool name");
    if (data.args !== undefined)
      current.args += str(data.args, "tool arguments");
    if (data.signature !== undefined)
      current.signature = str(data.signature, "tool signature");
    if (current.name.length > 256 || current.args.length > 1048576)
      bad("Upstream tool is too large");
    tools.set(index, current);
    yield {
      type: "tool",
      index,
      id: current.id,
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.args !== undefined ? { arguments: data.args } : {}),
      ...(data.signature !== undefined
        ? { thoughtSignature: data.signature }
        : {}),
    };
  }
  function* doneTool(key: any): Generator<AIEvent> {
    const index = toolIndex(key),
      current = tools.get(index);
    if (!current) return bad("Tool completed before it was declared");
    if (current.done) return;
    if (!current.name) bad("Missing upstream tool name");
    if (!current.args) yield* tool(key, { args: "{}" });
    try {
      const args = JSON.parse(current.args);
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw new Error();
    } catch {
      bad("Invalid or incomplete upstream tool arguments");
    }
    current.done = true;
    yield { type: "tool", index, done: true };
  }
  function reasonIndex(key: any) {
    if (!reasonKeys.has(key)) {
      if (reasonKeys.size >= 128) bad("Too many reasoning blocks");
      reasonKeys.set(key, reasonKeys.size);
    }
    return reasonKeys.get(key)!;
  }
  function updateReason(
    key: any,
    text = "",
    extra: Partial<ReasoningContent> = {},
  ) {
    const index = reasonIndex(key),
      previous = reasoning.get(index) ?? {
        source: protocol,
        text: "",
        sent: false,
      };
    if (previous.sent) bad("Reasoning content after completion");
    previous.text += text;
    Object.assign(previous, extra);
    reasoning.set(index, previous);
    if (previous.text.length + (previous.signature?.length ?? 0) > 1048576)
      bad("Reasoning block is too large");
    return index;
  }
  function* doneReason(key: any): Generator<AIEvent> {
    const index = reasonIndex(key),
      b = reasoning.get(index);
    if (!b || b.sent) return;
    const value = readReasoning(protocol, b.text, b.signature ?? b.encrypted, {
      ...(b.id ? { id: b.id } : {}),
      ...(b.redacted ? { redacted: b.redacted } : {}),
    });
    if (
      protocol === "openai-responses" &&
      value.source === protocol &&
      value.signature
    ) {
      value.encrypted = value.signature;
      delete value.signature;
    }
    b.sent = true;
    yield { type: "reasoning", index, ...value };
  }
  function* textDelta(
    key: any,
    delta: any,
    refusal = false,
  ): Generator<AIEvent> {
    const value = str(delta, "text delta"),
      map = refusal ? sentRefusal : sentText;
    map.set(key, (map.get(key) ?? "") + value);
    if (value)
      yield refusal
        ? { type: "refusal", text: value }
        : { type: "text", text: value };
  }
  function* textDone(key: any, full: any, refusal = false): Generator<AIEvent> {
    if (full === undefined) return;
    const value = str(full, "text"),
      map = refusal ? sentRefusal : sentText,
      previous = map.get(key) ?? "";
    if (!value.startsWith(previous))
      bad("Upstream text snapshot disagrees with deltas");
    if (value.length > previous.length)
      yield* textDelta(key, value.slice(previous.length), refusal);
  }
  function* responseItem(item: any, done: boolean): Generator<AIEvent> {
    if (!item || typeof item !== "object") return bad("Missing Responses item");
    const key = item.id ?? item.call_id;
    if (item.type === "function_call") {
      const index = toolIndex(key),
        current = tools.get(index);
      if (!current)
        yield* tool(key, {
          id: item.call_id,
          name: item.name,
          ...(item.extra_content?.google?.thought_signature
            ? { signature: item.extra_content.google.thought_signature }
            : {}),
        });
      const state = tools.get(index)!;
      if (
        (item.call_id !== undefined && item.call_id !== state.id) ||
        (item.name !== undefined && item.name !== state.name)
      )
        bad("Conflicting Responses tool metadata");
      const signature = item.extra_content?.google?.thought_signature;
      if (signature !== undefined && signature !== state.signature) {
        if (state.done) bad("Tool signature arrived after completion");
        yield* tool(key, { signature });
      }
      if (done && !state.done) {
        const full = item.arguments ?? state.args;
        if (!str(full, "tool arguments").startsWith(state.args))
          bad("Tool snapshot disagrees with deltas");
        if (full.length > state.args.length)
          yield* tool(key, { args: full.slice(state.args.length) });
        yield* doneTool(key);
      }
    } else if (item.type === "reasoning") {
      const index = reasonIndex(key),
        current = reasoning.get(index);
      if (!current)
        updateReason(key, "", { ...(item.id ? { id: item.id } : {}) });
      if (done && !reasoning.get(index)!.sent) {
        const full = (item.summary ?? [])
          .map((p: any) => str(p.text, "reasoning summary"))
          .join("");
        const state = reasoning.get(index)!;
        if (full && !full.startsWith(state.text))
          bad("Reasoning snapshot disagrees with deltas");
        if (full.length > state.text.length) state.text = full;
        if (item.encrypted_content)
          state.encrypted = str(item.encrypted_content, "encrypted reasoning");
      }
    } else if (item.type === "message") {
      if (done)
        for (const [i, part] of (item.content ?? []).entries()) {
          if (part.type === "refusal")
            yield* textDone(key + ":" + i, part.refusal, true);
          else if (part.type === "output_text")
            yield* textDone(key + ":" + i, part.text);
          else bad("Unsupported Responses content part");
        }
    } else bad("Unsupported Responses output item");
  }
  for await (const frame of parseSSE(body)) {
    if (frame.data === "[DONE]") {
      if (protocol !== "openai-chat" || !terminal)
        bad("Unexpected stream terminator");
      break;
    }
    let d: any;
    try {
      d = JSON.parse(frame.data);
    } catch {
      bad("Invalid upstream SSE JSON");
    }
    if (!d || typeof d !== "object" || Array.isArray(d))
      bad("Invalid upstream event");
    if (d.error || d.type === "error" || d.type === "response.failed")
      throw new HostError("upstream_error", "Upstream stream failed", 502);
    if (protocol === "openai-chat") {
      for (const choice of d.choices ?? []) {
        if (choice.index !== 0) bad("Multiple choices are unsupported");
        const delta = choice.delta ?? {};
        if (
          terminal &&
          Object.values(delta).some((v) => v !== null && v !== "")
        )
          bad("Content after completion");
        if (delta.content !== undefined && delta.content !== null)
          yield* textDelta("text", delta.content);
        if (delta.refusal) yield* textDelta("refusal", delta.refusal, true);
        if (delta.reasoning_details) {
          for (const detail of delta.reasoning_details) {
            const index = reasonIndex(detail.index ?? 0);
            const source = detail.format ?? protocol;
            if (
              ![
                "openai-chat",
                "openai-responses",
                "anthropic",
                "gemini",
              ].includes(source)
            )
              bad("Unknown reasoning source");
            yield {
              type: "reasoning",
              index,
              source,
              text: str(detail.text ?? "", "reasoning text"),
              ...(detail.signature
                ? { signature: str(detail.signature, "reasoning signature") }
                : {}),
              ...(detail.data
                ? source === "anthropic"
                  ? { redacted: str(detail.data, "redacted reasoning") }
                  : { encrypted: str(detail.data, "encrypted reasoning") }
                : {}),
              ...(detail.id ? { id: detail.id } : {}),
            };
          }
        } else if (delta.reasoning_content !== undefined)
          yield {
            type: "reasoning",
            index: 0,
            source: protocol,
            text: str(delta.reasoning_content, "reasoning"),
          };
        for (const c of delta.tool_calls ?? []) {
          if (!Number.isSafeInteger(c.index) || c.index < 0)
            bad("Invalid tool index");
          yield* tool(c.index, {
            id: c.id,
            name: c.function?.name,
            args: c.function?.arguments,
            signature: c.extra_content?.google?.thought_signature,
          });
        }
        if (choice.finish_reason) {
          terminal = true;
          finish = reason(choice.finish_reason);
        }
      }
      const usage = decodeUsage(protocol, d.usage);
      if (usage) yield { type: "usage", usage };
    } else if (protocol === "openai-responses") {
      if (d.type === "response.output_item.added")
        yield* responseItem(d.item, false);
      else if (d.type === "response.output_item.done")
        yield* responseItem(d.item, true);
      else if (d.type === "response.output_text.delta")
        yield* textDelta(d.item_id + ":" + (d.content_index ?? 0), d.delta);
      else if (d.type === "response.output_text.done")
        yield* textDone(d.item_id + ":" + (d.content_index ?? 0), d.text);
      else if (d.type === "response.refusal.delta")
        yield* textDelta(
          d.item_id + ":" + (d.content_index ?? 0),
          d.delta,
          true,
        );
      else if (d.type === "response.refusal.done")
        yield* textDone(
          d.item_id + ":" + (d.content_index ?? 0),
          d.refusal,
          true,
        );
      else if (d.type === "response.reasoning_summary_text.delta")
        updateReason(d.item_id, str(d.delta, "reasoning delta"));
      else if (d.type === "response.function_call_arguments.delta")
        yield* tool(d.item_id, { args: d.delta });
      else if (d.type === "response.function_call_arguments.done") {
        const current = tools.get(toolIndex(d.item_id));
        if (!current) bad("Tool arguments before declaration");
        const full = str(d.arguments, "tool arguments");
        if (!full.startsWith(current!.args))
          bad("Tool snapshot disagrees with deltas");
        if (full.length > current!.args.length)
          yield* tool(d.item_id, { args: full.slice(current!.args.length) });
        // Argument completion can precede output_item.done, which may add the
        // tool's signature. Complete the normalized tool with the final item.
      } else if (
        ["response.completed", "response.incomplete"].includes(d.type)
      ) {
        for (const entry of d.response?.output ?? [])
          yield* responseItem(entry, true);
        terminal = true;
        finish =
          d.type === "response.incomplete"
            ? d.response?.incomplete_details?.reason === "content_filter"
              ? "content_filter"
              : "length"
            : tools.size
              ? "tool_calls"
              : "stop";
        const usage = decodeUsage(protocol, d.response?.usage);
        if (usage) yield { type: "usage", usage };
      }
    } else if (protocol === "anthropic") {
      if (d.type === "message_start") anthropicUsage = { ...d.message?.usage };
      else if (d.type === "content_block_start") {
        const b = d.content_block;
        if (b?.type === "tool_use") {
          initialInputs.set(d.index, b.input ?? {});
          yield* tool(d.index, { id: b.id, name: b.name });
        } else if (b?.type === "thinking")
          updateReason(d.index, str(b.thinking ?? "", "thinking"), {
            ...(b.signature
              ? { signature: str(b.signature, "signature") }
              : {}),
          });
        else if (b?.type === "redacted_thinking")
          updateReason(d.index, "", {
            redacted: str(b.data, "redacted thinking"),
          });
        else if (b?.type === "text") {
          if (b.text) yield* textDelta(d.index, b.text);
        } else bad("Unsupported Anthropic content block");
      } else if (d.type === "content_block_delta") {
        if (d.delta?.type === "text_delta")
          yield* textDelta(d.index, d.delta.text);
        else if (d.delta?.type === "input_json_delta")
          yield* tool(d.index, { args: d.delta.partial_json });
        else if (d.delta?.type === "thinking_delta")
          updateReason(d.index, str(d.delta.thinking, "thinking"));
        else if (d.delta?.type === "signature_delta") {
          const index = reasonIndex(d.index),
            previous = reasoning.get(index)?.signature ?? "";
          updateReason(d.index, "", {
            signature: previous + str(d.delta.signature, "signature"),
          });
        } else bad("Unsupported Anthropic delta");
      } else if (d.type === "content_block_stop") {
        if (initialInputs.has(d.index)) {
          if (!tools.get(toolIndex(d.index))?.args)
            yield* tool(d.index, {
              args: JSON.stringify(initialInputs.get(d.index)),
            });
          yield* doneTool(d.index);
        }
        if (reasonKeys.has(d.index)) yield* doneReason(d.index);
      } else if (d.type === "message_delta") {
        anthropicUsage = { ...anthropicUsage, ...d.usage };
        const usage = decodeUsage(protocol, anthropicUsage);
        if (usage && Number.isSafeInteger(d.usage?.output_tokens))
          yield { type: "usage", usage };
        if (d.delta?.stop_reason) finish = reason(d.delta.stop_reason);
        if (d.delta?.stop_sequence)
          stopSequence = str(d.delta.stop_sequence, "stop sequence");
      } else if (d.type === "message_stop") terminal = true;
    } else {
      if (d.promptFeedback?.blockReason) {
        terminal = true;
        finish = "content_filter";
      }
      for (const candidate of d.candidates ?? []) {
        if (candidate.index !== undefined && candidate.index !== 0)
          bad("Multiple Gemini candidates are unsupported");
        for (const part of candidate.content?.parts ?? []) {
          if (part.functionCall) {
            if (geminiReason) {
              yield* doneReason(geminiReason);
              geminiReason = undefined;
            }
            const c = part.functionCall,
              args = c.args ?? {};
            if (!args || typeof args !== "object" || Array.isArray(args))
              bad("Invalid Gemini tool arguments");
            const key = c.id ?? "gemini-" + toolSerial++;
            const previous = tools.get(toolKeys.get(key)!);
            if (previous?.done) {
              if (
                previous.name !== c.name ||
                previous.args !== JSON.stringify(args) ||
                previous.signature !== part.thoughtSignature
              )
                bad("Conflicting Gemini tool snapshot");
              continue;
            }
            yield* tool(key, {
              id: c.id,
              name: c.name,
              args: JSON.stringify(args),
              signature: part.thoughtSignature,
            });
            yield* doneTool(key);
          } else if (
            part.thought === true ||
            (part.thoughtSignature && part.text === undefined)
          ) {
            geminiReason ??= "gemini-reason-" + geminiReasonSerial++;
            updateReason(
              geminiReason,
              str(part.text ?? "", "thinking"),
              part.thoughtSignature
                ? { signature: str(part.thoughtSignature, "signature") }
                : {},
            );
            if (part.thoughtSignature) {
              yield* doneReason(geminiReason);
              geminiReason = undefined;
            }
          } else if (typeof part.text === "string") {
            if (part.thoughtSignature)
              bad("Signed visible Gemini text is unsupported");
            if (geminiReason) {
              yield* doneReason(geminiReason);
              geminiReason = undefined;
            }
            yield* textDelta("text", part.text);
          } else bad("Unsupported Gemini part");
        }
        if (candidate.finishReason) {
          terminal = true;
          const why = reason(candidate.finishReason);
          finish =
            why === "content_filter" || why === "length"
              ? why
              : tools.size
                ? "tool_calls"
                : why;
        }
      }
      const usage = decodeUsage(protocol, d.usageMetadata);
      if (usage) yield { type: "usage", usage };
    }
    if (terminal && protocol !== "openai-chat") break;
  }
  if (!terminal)
    throw new HostError(
      "upstream_truncated",
      "Upstream stream ended before completion",
      502,
    );
  for (const key of toolKeys.keys()) yield* doneTool(key);
  for (const key of reasonKeys.keys()) yield* doneReason(key);
  yield {
    type: "finish",
    reason: finish,
    ...(stopSequence ? { stopSequence } : {}),
  };
}
