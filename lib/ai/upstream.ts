import { upstreamKey } from "./upstream-key.js";
import { upstreamRejection, prepareBeforeGeneration } from "./rejection.js";
import { definePlugin, HostError, requiredString } from "@pluhub/sdk";
import type { Protocol, AIRequest, Upstream } from "@pluhub/contracts/ai";
import { encodeRequest, decodeResult, resultEvents } from "./protocols.js";
import { discoverApiModels } from "./model-directory.js";
import { upstreamEvents } from "./streams.js";
import {
  interfaceHeaders,
  requestPath,
  upstreamUrl,
} from "./upstream-interfaces.js";
export function createUpstream(protocol: Protocol) {
  return definePlugin({
    setup(host) {
      host.provide(
        "ai.upstream-models." + protocol + "@1",
        (input: { upstream: Upstream; secret?: string }, signal) => {
          if (input.upstream.protocol !== protocol)
            throw new HostError("adapter_mismatch", "Wrong upstream adapter");
          return discoverApiModels(
            host,
            { ...input.upstream, protocol },
            signal,
            input.secret,
          );
        },
      );
      host.provide(
        "ai.upstream." + protocol + "@1",
        async (input: { request: AIRequest; upstream: Upstream }, signal) => {
          const { request, upstream } = input;
          if (upstream.protocol !== protocol)
            throw new HostError("adapter_mismatch", "Wrong upstream adapter");
          const key = await prepareBeforeGeneration(() =>
            upstreamKey(host, upstream, signal, request.sessionId),
          );
          const body = prepareBeforeGeneration(() =>
            encodeRequest(protocol, request),
          );
          const url = upstreamUrl(
            requiredString(upstream.baseUrl, "upstream URL", 2048),
            requestPath(protocol, upstream.http, request.stream),
            request.model,
          );
          if (
            protocol === "gemini" &&
            request.stream &&
            !url.searchParams.has("alt")
          )
            url.searchParams.set("alt", "sse");
          const headers = interfaceHeaders(protocol, upstream.http, key, url);
          const response = await host.call<Response>(
            "http.transport@1",
            {
              url: url.href,
              headers,
              body: JSON.stringify({
                ...(body as Record<string, unknown>),
                ...upstream.http?.params,
                ...(protocol === "gemini" &&
                upstream.http?.params?.generationConfig
                  ? {
                      generationConfig: {
                        ...(body as any).generationConfig,
                        ...(upstream.http.params.generationConfig as object),
                      },
                    }
                  : {}),
              }),
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
              "Empty upstream response",
              502,
            );
          if (
            request.stream &&
            response.headers.get("content-type")?.includes("text/event-stream")
          )
            return upstreamEvents(protocol, response.body);
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            for (;;) {
              signal.throwIfAborted();
              const item = await reader.read();
              if (item.done) break;
              size += item.value.length;
              if (size > 16 * 1024 * 1024) {
                await reader.cancel();
                throw new HostError(
                  "upstream_protocol",
                  "Upstream response too large",
                  502,
                );
              }
              chunks.push(item.value);
            }
          } finally {
            reader.releaseLock();
          }
          const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const rawUsage =
            protocol === "gemini" ? data.usageMetadata : data.usage;
          const fields =
            protocol === "openai-chat"
              ? ["prompt_tokens", "completion_tokens"]
              : protocol === "gemini"
                ? ["promptTokenCount", "candidatesTokenCount"]
                : ["input_tokens", "output_tokens"];
          const known = fields.every(
            (field) =>
              Number.isSafeInteger(rawUsage?.[field]) && rawUsage[field] >= 0,
          );
          const decoded = decodeResult(protocol, data, request.model);
          const events = resultEvents(decoded);
          return (async function* () {
            for await (const event of events)
              if (event.type !== "usage" || known) yield event;
          })();
        },
      );
    },
  });
}
