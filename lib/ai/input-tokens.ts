import type { Message, Tool } from "@pluhub/contracts/ai";

/**
 * Conservative UTF-8 byte bound for text/tool framing plus bounded vision image tokens,
 * avoiding multi-megabyte data URL or encrypted reasoning blob inflation.
 */
export function estimateInputTokens(messages: Message[], tools: Tool[]): number {
  let imageTokens = 0;
  const stripped = messages.map((message) => {
    const content = message.content?.flatMap((part) => {
      if (part.type === "image") {
        imageTokens += part.detail === "low" ? 85 : 1105;
        return [];
      }
      return [part];
    });
    const reasoning = message.reasoning?.map(({ source, text, id }) => ({
      source,
      text,
      ...(id ? { id } : {}),
    }));
    return {
      ...message,
      ...(content !== undefined ? (content.length ? { content } : { content: undefined }) : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
    };
  });
  return (
    Buffer.byteLength(JSON.stringify({ messages: stripped, tools }), "utf8") +
    imageTokens +
    1024
  );
}
