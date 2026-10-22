import { HostError, requiredString } from "@pluhub/sdk";
import type { AIRequest, Protocol } from "@pluhub/contracts/ai";
import { object, keys, unsupported, string } from "./content.js";
function bool(value: any, name: string): boolean | undefined {
  if (value !== undefined && typeof value !== "boolean")
    throw new HostError("invalid_request", "Invalid " + name);
  return value;
}
export function readOptions(protocol: Protocol, body: any): Partial<AIRequest> {
  const out: Partial<AIRequest> = {};
  const g = protocol === "gemini" ? (body.generationConfig ?? {}) : body;
  const topP = protocol === "gemini" ? g.topP : body.top_p;
  if (topP !== undefined) {
    if (
      typeof topP !== "number" ||
      !Number.isFinite(topP) ||
      topP < 0 ||
      topP > 1
    )
      throw new HostError("invalid_request", "Invalid top_p");
    out.topP = topP;
  }
  let stop =
    protocol === "gemini"
      ? g.stopSequences
      : protocol === "anthropic"
        ? body.stop_sequences
        : body.stop;
  if (stop !== undefined) {
    if (typeof stop === "string") stop = [stop];
    if (
      !Array.isArray(stop) ||
      stop.length > 16 ||
      stop.some((s) => typeof s !== "string" || !s.length || s.length > 4096)
    )
      throw new HostError("invalid_request", "Invalid stop sequences");
    out.stop = stop;
  }
  let choice = body.tool_choice;
  if (protocol === "gemini" && body.toolConfig !== undefined) {
    keys(body.toolConfig, ["functionCallingConfig"], "toolConfig");
    const config = object(body.toolConfig.functionCallingConfig);
    keys(config, ["mode", "allowedFunctionNames"], "functionCallingConfig");
    if (!["AUTO", "NONE", "ANY", "VALIDATED"].includes(config.mode))
      unsupported("function calling mode");
    const names = config.allowedFunctionNames ?? [];
    if (!Array.isArray(names) || names.length > 1)
      unsupported("multiple allowed function names");
    if (names.length && config.mode !== "ANY")
      unsupported("allowed function names without ANY mode");
    choice = names.length
      ? { name: requiredString(names[0], "tool name") }
      : config.mode === "NONE"
        ? "none"
        : config.mode === "ANY"
          ? "required"
          : "auto";
  } else if (protocol === "anthropic" && choice !== undefined) {
    keys(choice, ["type", "name", "disable_parallel_tool_use"], "tool_choice");
    if (choice.disable_parallel_tool_use !== undefined)
      out.parallelToolCalls = !bool(
        choice.disable_parallel_tool_use,
        "disable_parallel_tool_use",
      );
    choice =
      choice.type === "tool"
        ? { name: requiredString(choice.name, "tool name") }
        : choice.type === "any"
          ? "required"
          : choice.type;
  } else if (choice && typeof choice === "object") {
    keys(choice, ["type", "function", "name"], "tool_choice");
    if (choice.type !== "function") unsupported("tool_choice type");
    if (choice.function)
      keys(choice.function, ["name"], "tool_choice.function");
    choice = {
      name: requiredString(choice.function?.name ?? choice.name, "tool name"),
    };
  }
  if (choice !== undefined) {
    if (
      typeof choice !== "string" &&
      (!choice ||
        typeof choice !== "object" ||
        Array.isArray(choice) ||
        typeof choice.name !== "string")
    )
      throw new HostError("invalid_request", "Invalid tool_choice");
    if (
      typeof choice === "string" &&
      !["auto", "none", "required"].includes(choice)
    )
      unsupported("tool_choice");
    out.toolChoice = choice;
  }
  if (body.parallel_tool_calls !== undefined)
    out.parallelToolCalls = bool(
      body.parallel_tool_calls,
      "parallel_tool_calls",
    );
  let format =
    protocol === "openai-responses"
      ? body.text?.format
      : protocol === "anthropic"
        ? body.output_config?.format
        : body.response_format;
  if (protocol === "openai-responses" && body.text !== undefined)
    keys(body.text, ["format"], "text");
  if (
    protocol === "gemini" &&
    (g.responseMimeType !== undefined ||
      g.responseJsonSchema !== undefined ||
      g.responseSchema !== undefined)
  ) {
    if (g.responseSchema !== undefined)
      unsupported(
        "Gemini responseSchema; use responseJsonSchema for lossless JSON Schema conversion",
      );
    if (
      !["text/plain", "application/json", undefined].includes(
        g.responseMimeType,
      )
    )
      unsupported("responseMimeType");
    if (
      g.responseJsonSchema !== undefined &&
      g.responseMimeType !== "application/json"
    )
      throw new HostError(
        "invalid_request",
        "JSON schema requires application/json",
      );
    format =
      g.responseJsonSchema !== undefined
        ? {
            type: "json_schema",
            name: "response",
            schema: g.responseJsonSchema,
          }
        : {
            type:
              g.responseMimeType === "application/json"
                ? "json_object"
                : "text",
          };
  }
  if (format !== undefined) {
    object(format, "response format");
    if (["text", "json_object"].includes(format.type)) {
      keys(format, ["type"], "response format");
      out.responseFormat = { type: format.type };
    } else if (format.type === "json_schema") {
      const chat = protocol === "openai-chat",
        value = chat ? format.json_schema : format;
      keys(
        format,
        chat
          ? ["type", "json_schema"]
          : ["type", "name", "description", "schema", "strict"],
        "response format",
      );
      keys(
        value,
        chat
          ? ["name", "schema", "strict", "description"]
          : ["type", "name", "description", "schema", "strict"],
        "JSON schema",
      );
      out.responseFormat = {
        type: "json_schema",
        name: value.name
          ? requiredString(value.name, "schema name", 64)
          : "response",
        schema: object(value.schema, "schema"),
        ...(value.description !== undefined
          ? { description: string(value.description, "schema description") }
          : {}),
        ...(value.strict !== undefined
          ? { strict: bool(value.strict, "schema strict") }
          : {}),
      };
    } else unsupported("response format");
  }
  return out;
}
export function validateOptions(request: AIRequest) {
  const names = request.tools.map((t) => t.name);
  if (new Set(names).size !== names.length)
    throw new HostError("invalid_request", "Duplicate tool names");
  if (
    typeof request.toolChoice === "object" &&
    !names.includes(request.toolChoice.name)
  )
    throw new HostError("invalid_request", "Selected tool is not declared");
  if (request.toolChoice === "required" && !names.length)
    throw new HostError("invalid_request", "Required tool choice needs tools");
  for (const t of request.tools) {
    object(t.parameters, "tool parameters");
    if (t.strict !== undefined) bool(t.strict, "strict");
    if (t.description !== undefined) string(t.description, "tool description");
  }
}
export function writeOptions(
  protocol: Protocol,
  request: AIRequest,
): Record<string, any> {
  validateOptions(request);
  const out: any = {},
    choice = request.toolChoice,
    format = request.responseFormat;
  if (request.topP !== undefined)
    out[protocol === "gemini" ? "topP" : "top_p"] = request.topP;
  if (request.stop !== undefined) {
    if (protocol === "openai-responses" && request.stop.length)
      unsupported("stop sequences in Responses");
    else if (protocol !== "openai-responses")
      out[
        protocol === "gemini"
          ? "stopSequences"
          : protocol === "anthropic"
            ? "stop_sequences"
            : "stop"
      ] = request.stop;
  }
  if (protocol === "anthropic") {
    if (choice !== undefined || request.parallelToolCalls !== undefined)
      out.tool_choice = {
        ...(typeof choice === "object"
          ? { type: "tool", name: choice.name }
          : { type: choice === "required" ? "any" : (choice ?? "auto") }),
        ...(request.parallelToolCalls !== undefined
          ? { disable_parallel_tool_use: !request.parallelToolCalls }
          : {}),
      };
    if (format?.type === "json_object")
      unsupported(
        "unconstrained JSON object in Anthropic; provide a JSON schema",
      );
    if (
      format?.type === "json_schema" &&
      (format.strict === false || format.description !== undefined)
    )
      unsupported("relaxed JSON schema or schema description in Anthropic");
    if (format?.type === "json_schema")
      out.output_config = {
        format: { type: "json_schema", schema: format.schema },
      };
  } else if (protocol === "gemini") {
    if (
      request.tools.some((t) => t.strict) &&
      request.tools.some((t) => t.strict === false)
    )
      unsupported("mixed strict and relaxed tools in Gemini");
    if (request.parallelToolCalls === false)
      unsupported("disabling parallel tools in Gemini");
    if (choice !== undefined || request.tools.some((t) => t.strict))
      out.toolConfig = {
        functionCallingConfig: {
          mode:
            typeof choice === "object" || choice === "required"
              ? "ANY"
              : choice === "none"
                ? "NONE"
                : request.tools.some((t) => t.strict)
                  ? "VALIDATED"
                  : "AUTO",
          ...(typeof choice === "object"
            ? { allowedFunctionNames: [choice.name] }
            : {}),
        },
      };
    if (format) {
      if (
        format.type === "json_schema" &&
        (format.strict === false || format.description !== undefined)
      )
        unsupported("relaxed JSON schema or schema description in Gemini");
      out.responseMimeType =
        format.type === "text" ? "text/plain" : "application/json";
      if (format.type === "json_schema") out.responseJsonSchema = format.schema;
    }
  } else {
    if (choice !== undefined)
      out.tool_choice =
        typeof choice === "object"
          ? protocol === "openai-chat"
            ? { type: "function", function: { name: choice.name } }
            : { type: "function", name: choice.name }
          : choice;
    if (request.parallelToolCalls !== undefined)
      out.parallel_tool_calls = request.parallelToolCalls;
    if (format) {
      const value =
        format.type === "json_schema"
          ? {
              name: format.name,
              schema: format.schema,
              ...(format.description !== undefined
                ? { description: format.description }
                : {}),
              ...(format.strict !== undefined ? { strict: format.strict } : {}),
            }
          : {};
      if (protocol === "openai-chat")
        out.response_format =
          format.type === "json_schema"
            ? { type: "json_schema", json_schema: value }
            : format;
      else out.text = { format: { type: format.type, ...value } };
    }
  }
  return out;
}
