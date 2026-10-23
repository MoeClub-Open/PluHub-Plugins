import { HostError } from "@pluhub/sdk";
const readers = new WeakMap<
  ReadableStream<Uint8Array>,
  ReadableStreamDefaultReader<Uint8Array>
>();
export async function cancelSSE(body: ReadableStream<Uint8Array>) {
  const reader = readers.get(body);
  if (reader) await reader.cancel().catch(() => {});
  else if (!body.locked) await body.cancel().catch(() => {});
}
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  maximumEventSize = 1048576,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  readers.set(body, reader);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let finished = false;
  let event = "message",
    data: string[] = [],
    eventSize = 0;
  let scan = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      try {
        buffer += done
          ? decoder.decode()
          : decoder.decode(value, { stream: true });
      } catch {
        throw new HostError("upstream_protocol", "Invalid upstream UTF-8", 502);
      }
      let match: RegExpExecArray | null;
      const newline = /\r\n|\r|\n/g;
      newline.lastIndex = scan;
      while ((match = newline.exec(buffer))) {
        if (!done && match[0] === "\r" && match.index === buffer.length - 1) {
          scan = match.index;
          break;
        }
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        newline.lastIndex = 0;
        scan = 0;
        eventSize += line.length + 1;
        if (eventSize > maximumEventSize)
          throw new HostError("upstream_protocol", "SSE event too large", 502);
        if (!line) {
          if (data.length)
            yield { event: event || "message", data: data.join("\n") };
          event = "message";
          data = [];
          eventSize = 0;
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":"),
            field = colon < 0 ? line : line.slice(0, colon),
            value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "event") event = value;
          if (field === "data") data.push(value);
        }
      }
      if (!match) scan = buffer.length;
      if (buffer.length + eventSize > maximumEventSize)
        throw new HostError("upstream_protocol", "SSE event too large", 502);
      if (done) {
        finished = true;
        break;
      }
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    readers.delete(body);
    reader.releaseLock();
  }
}
