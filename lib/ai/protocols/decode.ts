import { randomUUID } from "node:crypto";
import { HostError, requiredString } from "@pluhub/sdk";
import type { AIRequest, Message, Protocol, Tool } from "@pluhub/contracts/ai";
import { contentMessage, object, readContent, readReasoning, string } from "../content.js";
import { decodeReasoning } from "../reasoning.js";
import { readOptions, validateOptions } from "../request-options.js";
import { sessionPayload } from "../session.js";
import { isSearchTool, messageCitations, readCitations, readSearchCall, readWebSearch } from "../web-search.js";
import { call, fields, number, parseArgs, readReasoningDetails, role, text, unsupported } from "./helpers.js";

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
