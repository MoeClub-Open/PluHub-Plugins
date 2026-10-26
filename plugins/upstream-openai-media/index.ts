import { upstreamKey } from "../../lib/ai/upstream-key.js";
import { definePlugin, HostError, requiredString } from "@pluhub/sdk";
import type { AIEvent, AIRequest, Upstream } from "@pluhub/contracts/ai";
import { mediaPaths, mediaUsage, readBytes } from "../../lib/ai/media.js";
import {
  upstreamRejection,
  prepareBeforeGeneration,
} from "../../lib/ai/rejection.js";
import {
  interfaceHeaders,
  upstreamUrl,
} from "../../lib/ai/upstream-interfaces.js";
import { parseSSE, cancelSSE } from "../../lib/ai/sse.js";

export default definePlugin({
  setup(host) {
    for (const protocol of ["openai-chat", "openai-responses"])
      host.provide(
        "ai.media." + protocol + "@1",
        async (
          { request, upstream }: { request: AIRequest; upstream: Upstream },
          signal,
        ) => {
          const operation = request.operation;
          if (!operation || upstream.protocol !== protocol)
            throw new HostError(
              "adapter_mismatch",
              "Wrong media upstream adapter",
            );
          const key = await prepareBeforeGeneration(() =>
            upstreamKey(host, upstream, signal, request.sessionId),
          );
          const url = upstreamUrl(
            requiredString(upstream.baseUrl, "upstream URL", 2048),
            upstream.http?.mediaPaths?.[operation.kind] ??
              mediaPaths[operation.kind],
            request.model,
          );
          const headers = new Headers(
            interfaceHeaders(protocol, upstream.http, key, url),
          );
          const input: Record<string, any> = {
            ...operation.input,
            ...upstream.http?.params,
            model: request.model,
          };
          let body: string | Uint8Array;
          if (operation.parts) {
            const form = new FormData();
            const overrides = new Set(Object.keys(upstream.http?.params ?? {}));
            for (const part of operation.parts) {
              if (part.name === "model" || overrides.has(part.name)) continue;
              if (typeof part.value === "string")
                form.append(part.name, part.value);
              else
                form.append(
                  part.name,
                  new Blob([new Uint8Array(part.value.data)], {
                    type: part.value.contentType,
                  }),
                  part.value.filename,
                );
            }
            form.set("model", request.model);
            for (const name of overrides)
              form.set(
                name,
                typeof input[name] === "object"
                  ? JSON.stringify(input[name])
                  : String(input[name]),
              );
            const encoded = new Request("http://multipart.invalid", {
              method: "POST",
              body: form,
            });
            headers.set("content-type", encoded.headers.get("content-type")!);
            body = new Uint8Array(await encoded.arrayBuffer());
          } else {
            // stream_format governs speech streaming; its API does not accept a stream parameter.
            if (operation.kind === "audio/speech") delete input.stream;
            headers.set("content-type", "application/json");
            body = JSON.stringify(input);
          }
          headers.delete("content-length");
          const response = await host.call<Response>(
            "http.transport@1",
            {
              url: url.href,
              headers: Object.fromEntries(headers),
              body,
              publicOnly: upstream.publicOnly,
            },
            signal,
          );
          if (!response.ok) {
            await response.body?.cancel();
            throw upstreamRejection(response.status);
          }
          if (!response.body)
            throw new HostError(
              "upstream_protocol",
              "Empty media upstream response",
              502,
            );
          const contentType =
            response.headers.get("content-type") ?? "application/octet-stream";
          const source = response.body;
          const abort = () => {
            void cancelSSE(source).catch(() => {});
          };
          signal.addEventListener("abort", abort, { once: true });
          return (async function* (): AsyncGenerator<AIEvent> {
            try {
              signal.throwIfAborted();
              if (contentType.includes("text/event-stream")) {
                if (!request.stream)
                  throw new HostError(
                    "upstream_protocol",
                    "Unexpected media event stream",
                    502,
                  );
                let completed = false;
                for await (const event of parseSSE(source, 64 * 1024 * 1024)) {
                  signal.throwIfAborted();
                  const data = JSON.parse(event.data);
                  if (data.error || data.type === "error")
                    throw new HostError(
                      "upstream_error",
                      "Media stream failed",
                      502,
                    );
                  const usage = mediaUsage(operation.kind, data);
                  if (usage) yield { type: "usage", usage };
                  if (
                    [
                      "image_generation.completed",
                      "image_edit.completed",
                      "transcript.text.done",
                      "transcript.done",
                      "speech.audio.done",
                    ].includes(data.type)
                  )
                    completed = true;
                  yield {
                    type: "media",
                    contentType,
                    body: new TextEncoder().encode(
                      (event.event !== "message"
                        ? "event: " + event.event + "\n"
                        : "") +
                        "data: " +
                        JSON.stringify(data) +
                        "\n\n",
                    ),
                  };
                }
                if (!completed)
                  throw new HostError(
                    "upstream_truncated",
                    "Media stream ended before completion",
                    502,
                  );
              } else if (contentType.includes("json")) {
                const data = JSON.parse(
                  new TextDecoder("utf-8", { fatal: true }).decode(
                    await readBytes(source, 64 * 1024 * 1024, signal),
                  ),
                );
                if (
                  !data ||
                  typeof data !== "object" ||
                  Array.isArray(data) ||
                  data.error
                )
                  throw new HostError(
                    "upstream_protocol",
                    "Invalid media response",
                    502,
                  );
                if (
                  (operation.kind === "embeddings" ||
                    operation.kind.startsWith("images/")) &&
                  (!Array.isArray(data.data) || !data.data.length)
                )
                  throw new HostError(
                    "upstream_protocol",
                    "Missing media data",
                    502,
                  );
                if (
                  operation.kind === "embeddings" &&
                  data.data.some(
                    (item: any) =>
                      !Number.isSafeInteger(item.index) ||
                      !(
                        typeof item.embedding === "string" ||
                        (Array.isArray(item.embedding) &&
                          item.embedding.every(
                            (n: unknown) =>
                              typeof n === "number" && Number.isFinite(n),
                          ))
                      ),
                  )
                )
                  throw new HostError(
                    "upstream_protocol",
                    "Invalid embedding data",
                    502,
                  );
                if (
                  operation.kind.startsWith("images/") &&
                  data.data.some(
                    (item: any) =>
                      typeof item.b64_json !== "string" &&
                      typeof item.url !== "string",
                  )
                )
                  throw new HostError(
                    "upstream_protocol",
                    "Invalid image data",
                    502,
                  );
                if (
                  operation.kind.startsWith("audio/") &&
                  typeof data.text !== "string"
                )
                  throw new HostError(
                    "upstream_protocol",
                    "Invalid transcription data",
                    502,
                  );
                const usage = mediaUsage(operation.kind, data);
                if (usage) yield { type: "usage", usage };
                yield { type: "media", contentType, body: data };
              } else {
                if (!operation.kind.startsWith("audio/"))
                  throw new HostError(
                    "upstream_protocol",
                    "Expected a JSON media response",
                    502,
                  );
                if (
                  operation.kind === "audio/speech"
                    ? !/^(audio\/|application\/octet-stream)/i.test(contentType)
                    : !/^text\/(plain|vtt|srt)|^application\/(x-subrip|octet-stream)/i.test(
                        contentType,
                      )
                )
                  throw new HostError(
                    "upstream_protocol",
                    "Unexpected audio response content type",
                    502,
                  );
                const reader = source.getReader();
                const cancel = () => {
                  void reader.cancel(signal.reason).catch(() => {});
                };
                signal.addEventListener("abort", cancel, { once: true });
                let length = 0;
                try {
                  for (;;) {
                    signal.throwIfAborted();
                    const item = await reader.read();
                    signal.throwIfAborted();
                    if (item.done) break;
                    length += item.value.length;
                    yield { type: "media", contentType, body: item.value };
                  }
                  if (!length)
                    throw new HostError(
                      "upstream_protocol",
                      "Empty audio response",
                      502,
                    );
                } finally {
                  signal.removeEventListener("abort", cancel);
                  await reader.cancel().catch(() => {});
                  reader.releaseLock();
                }
              }
              yield { type: "finish", reason: "stop" };
            } finally {
              signal.removeEventListener("abort", abort);
              if (!source.locked) await source.cancel().catch(() => {});
            }
          })();
        },
      );
  },
});
