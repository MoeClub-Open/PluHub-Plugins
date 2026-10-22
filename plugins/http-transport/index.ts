import { request, Agent } from "undici";
import { Readable } from "node:stream";
import { definePlugin, HostError } from "@pluhub/sdk";
import { assertPublicUrl, publicLookup } from "../../lib/ai/public-network.js";
const hop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
export default definePlugin({
  setup(host) {
    const dispatcher = new Agent({ connect: { timeout: 10000 } });
    const publicDispatcher = new Agent({
      connect: { timeout: 10000, lookup: publicLookup },
    });
    host.cleanup(() => dispatcher.destroy());
    host.cleanup(() => publicDispatcher.destroy());
    host.provide("http.transport@1", async (input, signal) => {
      const url = new URL(input.url);
      if (!["http:", "https:"].includes(url.protocol))
        throw new HostError("invalid_upstream", "Expected HTTP upstream");
      if (input.publicOnly) assertPublicUrl(url);
      const headers: Record<string, string> = {};
      const source = new Headers(input.headers);
      const excluded = new Set([
        ...hop,
        ...(source.get("connection") ?? "")
          .split(",")
          .map((x) => x.trim().toLowerCase()),
      ]);
      for (const [key, value] of source)
        if (!excluded.has(key) && key !== "host") headers[key] = value;
      const response = await request(url, {
        dispatcher: input.publicOnly ? publicDispatcher : dispatcher,
        method: input.method ?? "POST",
        headers,
        body:
          input.body instanceof ReadableStream
            ? Readable.fromWeb(input.body as any)
            : input.body,
        signal,
        headersTimeout: 30000,
        bodyTimeout: 120000,
      });
      const out = new Headers();
      const outExcluded = new Set([
        ...hop,
        ...String(response.headers.connection ?? "")
          .split(",")
          .map((v) => v.trim().toLowerCase()),
      ]);
      for (const [key, value] of Object.entries(response.headers))
        if (value !== undefined && !outExcluded.has(key)) {
          for (const item of Array.isArray(value) ? value : [value])
            out.append(key, item);
        }
      if (
        [204, 205, 304].includes(response.statusCode) ||
        input.method === "HEAD"
      ) {
        await response.body.dump();
        return new Response(null, {
          status: response.statusCode,
          headers: out,
        });
      }
      // Pull from Undici rather than forwarding data events through toWeb:
      // abort can race queued data events after that adapter closes its controller.
      const iterator = response.body[Symbol.asyncIterator]();
      let closed = false;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const item = await iterator.next();
            if (closed) return;
            if (item.done) {
              closed = true;
              controller.close();
            } else controller.enqueue(item.value);
          } catch (error) {
            if (!closed) {
              closed = true;
              controller.error(error);
            }
          }
        },
        async cancel() {
          closed = true;
          response.body.destroy();
          try {
            await iterator.return?.();
          } catch {}
        },
      });
      return new Response(body, { status: response.statusCode, headers: out });
    });
  },
});
