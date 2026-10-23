import { HostError, requiredString } from "@pluhub/sdk";
import type {
  AIRequest,
  Protocol,
  UrlCitation,
  WebSearch,
  WebSearchCall,
} from "@pluhub/contracts/ai";

export const searchTypes = [
  "web_search",
  "web_search_preview",
  "web_search_preview_2025_03_11",
] as const;
export const isSearchTool = (value: any) => searchTypes.includes(value?.type);
const unsupported = (message: string): never => {
  throw new HostError("web_search_unsupported", message);
};

export function readWebSearch(
  protocol: Protocol,
  body: any,
): WebSearch | undefined {
  if (!["openai-chat", "openai-responses"].includes(protocol)) return;
  const tools = Array.isArray(body.tools)
    ? body.tools.filter(isSearchTool)
    : [];
  if (
    tools.length > 1 ||
    (tools.length && body.web_search_options !== undefined)
  )
    throw new HostError("invalid_request", "Declare web search once");
  const tool =
    tools[0] ??
    (body.web_search_options !== undefined
      ? { ...body.web_search_options, type: "web_search" }
      : undefined);
  if (!tool) {
    if (body.max_tool_calls != null)
      throw new HostError(
        "unsupported_feature",
        "max_tool_calls requires a hosted tool",
      );
    if (isSearchTool(body.tool_choice))
      throw new HostError(
        "invalid_request",
        "Selected web search tool is not declared",
      );
    return;
  }
  if (
    body.web_search_options !== undefined &&
    (!body.web_search_options ||
      typeof body.web_search_options !== "object" ||
      Array.isArray(body.web_search_options))
  )
    throw new HostError("invalid_request", "Invalid web_search_options");
  const { type, ...options } = tool;
  if (
    body.max_tool_calls != null &&
    (!Number.isSafeInteger(body.max_tool_calls) || body.max_tool_calls < 1)
  )
    throw new HostError("invalid_request", "Invalid max_tool_calls");
  const choice = isSearchTool(body.tool_choice)
    ? body.tool_choice.type
    : undefined;
  if (choice && choice !== type)
    throw new HostError(
      "invalid_request",
      "Selected web search tool is not declared",
    );
  return {
    type,
    options,
    ...(body.max_tool_calls != null ? { maxCalls: body.max_tool_calls } : {}),
    ...(choice ? { choice } : {}),
    ...(body.include?.includes("web_search_call.action.sources")
      ? { includeSources: true }
      : {}),
  };
}

export function validateWebSearchTarget(
  request: AIRequest,
  protocol: string | undefined,
) {
  const search = request.webSearch;
  if (
    !search &&
    !request.messages.some((message) => message.searchCalls?.length)
  )
    return;
  if (!["openai-chat", "openai-responses", "codex"].includes(protocol ?? ""))
    unsupported(
      "Web search requires a Responses/Codex or compatible Chat upstream",
    );
  if (
    protocol === "openai-chat" &&
    search &&
    (request.toolChoice === "none" ||
      search.choice ||
      search.includeSources ||
      search.maxCalls !== undefined ||
      Object.keys(search.options).some(
        (key) => !["search_context_size", "user_location"].includes(key),
      ))
  )
    unsupported("These web search controls require a Responses/Codex upstream");
}

export function readSearchCall(value: any): WebSearchCall {
  if (!value || typeof value !== "object" || value.type !== "web_search_call")
    throw new HostError("upstream_protocol", "Invalid web search call", 502);
  requiredString(value.id, "web search call ID");
  return structuredClone(value);
}

export function readCitations(value: unknown, offset = 0): UrlCitation[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value))
    throw new HostError("upstream_protocol", "Invalid citations", 502);
  return value.map((annotation) => {
    const citation = annotation?.url_citation ?? annotation;
    if (
      annotation?.type !== "url_citation" ||
      typeof citation.url !== "string" ||
      !Number.isSafeInteger(citation.start_index) ||
      !Number.isSafeInteger(citation.end_index) ||
      citation.start_index < 0 ||
      citation.end_index < citation.start_index
    )
      throw new HostError("upstream_protocol", "Invalid URL citation", 502);
    let url: URL;
    try {
      url = new URL(citation.url);
    } catch {
      throw new HostError("upstream_protocol", "Invalid citation URL", 502);
    }
    if (!["http:", "https:"].includes(url.protocol))
      throw new HostError("upstream_protocol", "Invalid citation URL", 502);
    return {
      url: citation.url,
      title: typeof citation.title === "string" ? citation.title : citation.url,
      startIndex: citation.start_index + offset,
      endIndex: citation.end_index + offset,
    };
  });
}

export function writeCitations(citations: UrlCitation[] = [], chat = false) {
  return citations.map(({ url, title, startIndex, endIndex }) => {
    const citation = {
      url,
      title,
      start_index: startIndex,
      end_index: endIndex,
    };
    return chat
      ? { type: "url_citation", url_citation: citation }
      : { type: "url_citation", ...citation };
  });
}

export function messageCitations(content: any): UrlCitation[] {
  if (!Array.isArray(content)) return [];
  let offset = 0;
  return content.flatMap((part) => {
    const citations = readCitations(part.annotations, offset);
    offset += typeof part.text === "string" ? part.text.length : 0;
    return citations;
  });
}
