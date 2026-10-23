import {
  isSearchTool,
  readWebSearch,
  readSearchCall,
  readCitations,
  writeCitations,
  messageCitations,
  validateWebSearchTarget,
} from "./web-search.js";
import { randomUUID } from "node:crypto";
import { HostError, requiredString } from "@pluhub/sdk";
import { decodeReasoning, encodeReasoning } from "./reasoning.js";
import { decodeUsage, encodeUsage } from "./usage.js";
import { sessionPayload } from "./session.js";
import {
  readContent,
  writeContent,
  contentMessage,
  readReasoning,
  packReasoning,
  assertReasoningTarget,
  object,
  string,
} from "./content.js";
import {
  readOptions,
  writeOptions,
  validateOptions,
} from "./request-options.js";
import type {
  Protocol,
  AIRequest,
  AIEvent,
  AIResult,
  Message,
  Tool,
  ReasoningContent,
} from "@pluhub/contracts/ai";
export type {
  Protocol,
  AIRequest,
  AIEvent,
  AIResult,
} from "@pluhub/contracts/ai";
const unsupported = (field: string): never => {
  throw new HostError("unsupported_feature", "Unsupported feature: " + field);
};
function fields(value: any, allowed: string[], where = "request") {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HostError("invalid_request", "Invalid " + where);
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) unsupported(where + "." + key);
}
function text(value: any): string {
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
function number(value: any, name: string, min: number, max: number) {
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
function role(value: any): Message["role"] {
  if (!["system", "developer", "user", "assistant", "tool"].includes(value))
    throw new HostError("invalid_request", "Invalid message role");
  return value;
}
function call(value: any) {
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
function readReasoningDetails(value: any) {
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
function reasoningHistory(protocol: Protocol, message: Message): any[] {
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
export function decode(
  protocol: Protocol,
  body: any,
  pathModel?: string,
): AIRequest {
  body = sessionPayload(body);
  const messages: Message[] = [];
  const webSearch = readWebSearch(protocol, body);
  let tools: Tool[] = [];
  let maxTokens: number | undefined;
  let temperature: number | undefined;
  let model = body?.model ?? pathModel;
  let stream = body?.stream ?? false;
  if (body?.tools !== undefined && !Array.isArray(body.tools))
    throw new HostError("invalid_request", "tools must be an array");
  if (typeof stream !== "boolean")
    throw new HostError("invalid_request", "stream must be boolean");
  if (protocol === "openai-chat") {
    fields(body, [
      "model",
      "messages",
      "stream",
      "tools",
      "max_tokens",
      "max_completion_tokens",
      "temperature",
      "stream_options",
      "n",
      "reasoning_effort",
      "top_p",
      "stop",
      "tool_choice",
      "parallel_tool_calls",
      "response_format",
      "web_search_options",
    ]);
    if (body.n !== undefined && body.n !== 1) unsupported("n");
    if (body.stream_options) {
      fields(body.stream_options, ["include_usage"]);
      if (
        body.stream_options.include_usage !== undefined &&
        typeof body.stream_options.include_usage !== "boolean"
      )
        throw new HostError("invalid_request", "include_usage must be boolean");
    }
    if (!Array.isArray(body.messages))
      throw new HostError("invalid_request", "messages must be an array");
    for (const m of body.messages) {
      fields(
        m,
        [
          "role",
          "content",
          "tool_calls",
          "tool_call_id",
          "name",
          "reasoning_content",
          "reasoning_details",
          "refusal",
          "annotations",
          "extra_content",
        ],
        "message",
      );
      if (m.tool_calls !== undefined && !Array.isArray(m.tool_calls))
        throw new HostError("invalid_request", "tool_calls must be an array");
      if (m.role === "tool") requiredString(m.tool_call_id, "tool_call_id");
      if (m.extra_content)
        fields(m.extra_content, ["web_search_calls"], "message extra_content");
      messages.push({
        ...contentMessage(role(m.role), readContent(protocol, m.content)),
        ...(m.reasoning_details
          ? { reasoning: readReasoningDetails(m.reasoning_details) }
          : m.reasoning_content !== undefined
            ? { reasoning: [readReasoning(protocol, m.reasoning_content)] }
            : {}),
        ...(m.tool_calls ? { calls: m.tool_calls.map(call) } : {}),
        ...(m.annotations?.length
          ? { citations: readCitations(m.annotations) }
          : {}),
        ...(m.extra_content?.web_search_calls
          ? {
              searchCalls: m.extra_content.web_search_calls.map(readSearchCall),
            }
          : {}),
        ...(m.tool_call_id ? { callId: m.tool_call_id, toolName: m.name } : {}),
        ...(m.refusal !== undefined && m.refusal !== null
          ? { refusal: string(m.refusal, "refusal") }
          : {}),
      });
    }
    tools = (body.tools ?? [])
      .filter((t: any) => !isSearchTool(t))
      .map((t: any) => {
        fields(t, ["type", "function"], "tool");
        if (t.type !== "function") unsupported("tool type");
        fields(
          t.function,
          ["name", "description", "parameters", "strict"],
          "function",
        );
        return {
          name: requiredString(t.function.name, "tool name"),
          description: t.function.description,
          parameters: t.function.parameters ?? { type: "object" },
          ...(t.function.strict !== undefined
            ? { strict: t.function.strict }
            : {}),
        };
      });
    maxTokens = body.max_completion_tokens ?? body.max_tokens;
    if (
      body.max_completion_tokens !== undefined &&
      body.max_tokens !== undefined &&
      body.max_completion_tokens !== body.max_tokens
    )
      throw new HostError("invalid_request", "Conflicting output token limits");
    temperature = body.temperature;
  } else if (protocol === "openai-responses") {
    fields(body, [
      "model",
      "input",
      "instructions",
      "stream",
      "tools",
      "max_output_tokens",
      "max_tool_calls",
      "temperature",
      "store",
      "reasoning",
      "top_p",
      "tool_choice",
      "parallel_tool_calls",
      "text",
      "include",
    ]);
    if (body.store !== undefined && typeof body.store !== "boolean")
      throw new HostError("invalid_request", "store must be boolean");
    if (body.store === true) unsupported("store");
    if (
      body.include !== undefined &&
      (!Array.isArray(body.include) ||
        body.include.some(
          (v: any) =>
            ![
              "reasoning.encrypted_content",
              "web_search_call.action.sources",
            ].includes(v),
        ))
    )
      unsupported("Responses include");
    if (body.instructions)
      messages.push({ role: "system", text: text(body.instructions) });
    if (typeof body.input === "string")
      messages.push({ role: "user", text: body.input });
    else if (Array.isArray(body.input))
      for (const item of body.input) {
        object(item, "input item");
        if (item.type === "reasoning") {
          fields(
            item,
            ["type", "id", "summary", "encrypted_content", "status"],
            "reasoning item",
          );
          if (item.summary !== undefined && !Array.isArray(item.summary))
            throw new HostError("invalid_request", "Invalid reasoning summary");
          const summary = (item.summary ?? [])
            .map((s: any) => {
              fields(s, ["type", "text"], "reasoning summary");
              if (s.type !== "summary_text")
                unsupported("reasoning summary type");
              return string(s.text, "summary");
            })
            .join("");
          const block = readReasoning(
            protocol,
            summary,
            item.encrypted_content,
            { ...(item.id ? { id: string(item.id, "reasoning id") } : {}) },
          );
          if (block.signature && block.source === protocol) {
            block.encrypted = block.signature;
            delete block.signature;
          }
          messages.push({ role: "assistant", text: "", reasoning: [block] });
        } else if (item.type === "web_search_call") {
          messages.push({
            role: "assistant",
            text: "",
            searchCalls: [readSearchCall(item)],
          });
        } else if (item.type === "function_call") {
          fields(
            item,
            [
              "type",
              "id",
              "call_id",
              "name",
              "arguments",
              "status",
              "extra_content",
            ],
            "function call",
          );
          messages.push({ role: "assistant", text: "", calls: [call(item)] });
        } else if (item.type === "function_call_output") {
          fields(
            item,
            ["type", "id", "call_id", "output", "status"],
            "function output",
          );
          messages.push({
            role: "tool",
            text: string(item.output, "tool output"),
            callId: requiredString(item.call_id, "call_id"),
          });
        } else {
          if (item.type && item.type !== "message")
            unsupported("input item " + item.type);
          fields(
            item,
            ["type", "role", "content", "id", "status"],
            "input message",
          );
          const parts = Array.isArray(item.content)
            ? item.content.filter((p: any) => p?.type !== "refusal")
            : item.content;
          const refusals = Array.isArray(item.content)
            ? item.content
                .filter((p: any) => p?.type === "refusal")
                .map((p: any) => {
                  fields(p, ["type", "refusal"], "refusal");
                  return string(p.refusal, "refusal");
                })
                .join("")
            : "";
          messages.push({
            ...contentMessage(role(item.role), readContent(protocol, parts)),
            ...(messageCitations(parts).length
              ? { citations: messageCitations(parts) }
              : {}),
            ...(refusals ? { refusal: refusals } : {}),
          });
        }
      }
    else
      throw new HostError("invalid_request", "input must be text or messages");
    tools = (body.tools ?? [])
      .filter((t: any) => !isSearchTool(t))
      .map((t: any) => {
        fields(
          t,
          ["type", "name", "description", "parameters", "strict"],
          "tool",
        );
        if (t.type !== "function") unsupported("tool type");
        return {
          name: requiredString(t.name, "tool name"),
          description: t.description,
          parameters: t.parameters ?? { type: "object" },
          ...(t.strict !== undefined ? { strict: t.strict } : {}),
        };
      });
    maxTokens = body.max_output_tokens;
    temperature = body.temperature;
  } else if (protocol === "anthropic") {
    fields(body, [
      "model",
      "system",
      "messages",
      "stream",
      "tools",
      "max_tokens",
      "temperature",
      "thinking",
      "output_config",
      "top_p",
      "stop_sequences",
      "tool_choice",
    ]);
    if (body.system) {
      const system = contentMessage(
        "system",
        readContent(protocol, body.system),
      );
      if (system.content) unsupported("non-text system content");
      messages.push(system);
    }
    if (!Array.isArray(body.messages))
      throw new HostError("invalid_request", "messages required");
    for (const m of body.messages) {
      fields(m, ["role", "content"], "message");
      if (!["user", "assistant"].includes(m.role))
        throw new HostError("invalid_request", "Invalid Anthropic role");
      let msg: Message = { role: role(m.role), text: "" };
      const flush = () => {
        if (
          msg.text ||
          msg.content?.length ||
          msg.calls?.length ||
          msg.reasoning?.length
        )
          messages.push(msg);
        msg = { role: role(m.role), text: "" };
      };
      if (typeof m.content === "string") msg.text = m.content;
      else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          object(b, "content block");
          if (["text", "image"].includes(b.type)) {
            if (msg.calls?.length) flush();
            const parts = readContent(protocol, [b]);
            msg.content ??= msg.text ? [{ type: "text", text: msg.text }] : [];
            msg.content.push(...parts);
            msg.text += parts
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("");
          } else if (["thinking", "redacted_thinking"].includes(b.type)) {
            fields(
              b,
              b.type === "thinking"
                ? ["type", "thinking", "signature"]
                : ["type", "data"],
              "thinking block",
            );
            flush();
            const block =
              b.type === "thinking"
                ? readReasoning(protocol, b.thinking, b.signature)
                : readReasoning(protocol, "", undefined, {
                    redacted: string(b.data, "redacted thinking"),
                  });
            msg.reasoning = [block];
            flush();
          } else if (b.type === "tool_use") {
            fields(b, ["type", "id", "name", "input"], "tool use");
            if (m.role !== "assistant")
              throw new HostError(
                "invalid_request",
                "Tool use requires assistant role",
              );
            (msg.calls ??= []).push({
              id: requiredString(b.id, "id"),
              name: requiredString(b.name, "name"),
              arguments: JSON.stringify(object(b.input ?? {}, "tool input")),
            });
          } else if (b.type === "tool_result") {
            if (m.role !== "user")
              throw new HostError(
                "invalid_request",
                "Tool result requires user role",
              );
            flush();
            fields(
              b,
              ["type", "tool_use_id", "content", "is_error"],
              "tool result",
            );
            if (b.is_error !== undefined && typeof b.is_error !== "boolean")
              throw new HostError("invalid_request", "Invalid tool error flag");
            messages.push({
              ...contentMessage("tool", readContent(protocol, b.content)),
              callId: requiredString(b.tool_use_id, "tool_use_id"),
              ...(b.is_error !== undefined ? { toolError: b.is_error } : {}),
            });
          } else unsupported("content block " + b.type);
        }
      } else throw new HostError("invalid_request", "Invalid message content");
      flush();
    }
    tools = (body.tools ?? []).map((t: any) => {
      fields(t, ["name", "description", "input_schema", "strict"], "tool");
      return {
        name: requiredString(t.name, "tool name"),
        description: t.description,
        parameters: t.input_schema ?? { type: "object" },
        ...(t.strict !== undefined ? { strict: t.strict } : {}),
      };
    });
    maxTokens = body.max_tokens;
    temperature = body.temperature;
  } else {
    fields(body, [
      "contents",
      "systemInstruction",
      "tools",
      "generationConfig",
      "toolConfig",
    ]);
    stream = false;
    if (body.systemInstruction) {
      fields(body.systemInstruction, ["role", "parts"], "system instruction");
      const system = contentMessage(
        "system",
        readContent(protocol, body.systemInstruction.parts),
      );
      if (system.content) unsupported("non-text system content");
      messages.push(system);
    }
    if (!Array.isArray(body.contents))
      throw new HostError("invalid_request", "contents required");
    const known: { id: string; name: string }[] = [];
    for (const m of body.contents) {
      fields(m, ["role", "parts"], "content");
      if (m.role !== undefined && !["model", "user"].includes(m.role))
        throw new HostError("invalid_request", "Invalid Gemini role");
      let msg: Message = {
        role: m.role === "model" ? "assistant" : "user",
        text: "",
      };
      const flush = () => {
        if (
          msg.text ||
          msg.content?.length ||
          msg.calls?.length ||
          msg.reasoning?.length
        )
          messages.push(msg);
        msg = { role: m.role === "model" ? "assistant" : "user", text: "" };
      };
      if (!Array.isArray(m.parts))
        throw new HostError("invalid_request", "parts required");
      for (const b of m.parts) {
        object(b, "Gemini part");
        if (
          b.thought === true ||
          (b.thoughtSignature &&
            (b.text === undefined || b.text === "") &&
            !b.functionCall)
        ) {
          fields(b, ["text", "thought", "thoughtSignature"], "thinking part");
          flush();
          msg.reasoning = [readReasoning(protocol, b.text, b.thoughtSignature)];
          flush();
        } else if (
          typeof b.text === "string" ||
          b.inlineData ||
          b.inline_data ||
          b.fileData ||
          b.file_data
        ) {
          if (msg.calls?.length) flush();
          const parts = readContent(protocol, [b]);
          msg.content ??= msg.text ? [{ type: "text", text: msg.text }] : [];
          msg.content.push(...parts);
          msg.text += parts
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("");
        } else if (b.functionCall) {
          fields(b, ["functionCall", "thoughtSignature"], "function call part");
          const c = b.functionCall;
          fields(c, ["id", "name", "args"], "function call");
          if (m.role !== "model")
            throw new HostError(
              "invalid_request",
              "Function call requires model role",
            );
          const id =
            c.id !== undefined
              ? requiredString(c.id, "call ID")
              : "call_" + randomUUID();
          known.push({ name: c.name, id });
          (msg.calls ??= []).push({
            id,
            name: requiredString(c.name, "function name"),
            arguments: JSON.stringify(object(c.args ?? {}, "tool arguments")),
            ...(b.thoughtSignature
              ? {
                  thoughtSignature: string(
                    b.thoughtSignature,
                    "thought signature",
                  ),
                }
              : {}),
          });
        } else if (b.functionResponse) {
          fields(b, ["functionResponse"], "function response part");
          const c = b.functionResponse;
          fields(c, ["id", "name", "response"], "function response");
          if (m.role === "model")
            throw new HostError(
              "invalid_request",
              "Function response requires user role",
            );
          flush();
          const matches = known.filter((v) =>
            c.id ? v.id === c.id : v.name === c.name,
          );
          if (!c.id && matches.length !== 1)
            throw new HostError(
              "invalid_tool_result",
              "Ambiguous or unmatched Gemini tool result; provide its ID",
            );
          const match = matches[0];
          if (!match || c.name !== match.name)
            throw new HostError(
              "invalid_tool_result",
              "Unmatched Gemini tool result",
            );
          if (match) known.splice(known.indexOf(match), 1);
          messages.push({
            role: "tool",
            text: JSON.stringify(c.response ?? {}),
            callId: c.id ?? match!.id,
            toolName: c.name,
          });
        } else unsupported("Gemini part");
      }
      flush();
    }
    for (const group of body.tools ?? []) {
      fields(group, ["functionDeclarations"], "tool");
      if (!Array.isArray(group.functionDeclarations))
        throw new HostError(
          "invalid_request",
          "functionDeclarations must be an array",
        );
      for (const t of group.functionDeclarations ?? []) {
        fields(
          t,
          ["name", "description", "parameters", "parametersJsonSchema"],
          "function declaration",
        );
        tools.push({
          name: requiredString(t.name, "tool name"),
          description: t.description,
          parameters: t.parametersJsonSchema ??
            t.parameters ?? { type: "object" },
          ...(body.toolConfig?.functionCallingConfig?.mode === "VALIDATED"
            ? { strict: true }
            : {}),
        });
      }
    }
    if (body.generationConfig) {
      fields(
        body.generationConfig,
        [
          "maxOutputTokens",
          "temperature",
          "candidateCount",
          "thinkingConfig",
          "topP",
          "stopSequences",
          "responseMimeType",
          "responseJsonSchema",
          "responseSchema",
        ],
        "generationConfig",
      );
      if (
        body.generationConfig.candidateCount !== undefined &&
        body.generationConfig.candidateCount !== 1
      )
        unsupported("candidateCount");
      maxTokens = body.generationConfig.maxOutputTokens;
      temperature = body.generationConfig.temperature;
    }
  }
  if (!messages.length)
    throw new HostError("invalid_request", "At least one message required");
  model = requiredString(model, "model");
  maxTokens = number(maxTokens, "max tokens", 1, 1000000);
  if (maxTokens !== undefined && !Number.isInteger(maxTokens))
    throw new HostError("invalid_request", "max tokens must be an integer");
  temperature = number(temperature, "temperature", 0, 2);
  const reasoning = decodeReasoning(protocol, body);
  for (const m of messages) {
    if (m.content && !m.content.some((p) => p.type === "image"))
      delete m.content;
    if (
      (m.calls?.length ||
        m.reasoning?.length ||
        m.refusal ||
        m.citations?.length ||
        m.searchCalls?.length) &&
      m.role !== "assistant"
    )
      throw new HostError(
        "invalid_request",
        "Only assistant messages may contain calls, reasoning or refusal",
      );
    if (
      m.content?.some((p) => p.type === "image") &&
      !["user", "tool"].includes(m.role)
    )
      throw new HostError(
        "invalid_request",
        "Images require user or tool role",
      );
    for (const c of m.calls ?? []) parseArgs(c.arguments);
  }
  if (
    protocol === "anthropic" &&
    maxTokens !== undefined &&
    reasoning?.budgetTokens !== undefined &&
    reasoning.budgetTokens >= maxTokens
  )
    throw new HostError(
      "invalid_reasoning",
      "Thinking budget must be smaller than max_tokens",
    );
  const decoded: AIRequest = {
    model,
    messages,
    tools,
    ...(webSearch ? { webSearch } : {}),
    stream,
    maxTokens,
    temperature,
    ...(reasoning ? { reasoning } : {}),
    ...readOptions(protocol, body),
  };
  validateOptions(decoded);
  return decoded;
}
const parseArgs = (value: string) => {
  try {
    return object(JSON.parse(value), "tool arguments");
  } catch {
    throw new HostError(
      "invalid_tool_arguments",
      "Tool arguments must be JSON",
    );
  }
};
function mergeMessages(items: any[], field: "content" | "parts") {
  return items.reduce<any[]>((out, item) => {
    const last = out.at(-1);
    if (last?.role === item.role) last[field].push(...item[field]);
    else out.push(item);
    return out;
  }, []);
}
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
function tryJSON(value: string) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : { result: parsed };
  } catch {
    return { result: value };
  }
}
export { parseSSE, cancelSSE } from "./sse.js";
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
