import { definePlugin, HostError, requiredString } from "@pluhub/sdk";
import type {
  Protocol,
  AIRequest,
  Upstream,
  AIResult,
} from "@pluhub/contracts/ai";
import { encodeRequest, decodeResult, resultEvents } from "./protocols.js";
import { upstreamEvents } from "./streams.js";
export function createUpstream(protocol: Protocol) {
  return definePlugin({
    setup(host) {
      host.provide(
        "ai.upstream." + protocol + "@1",
        async (input: { request: AIRequest; upstream: Upstream }, signal) => {
          const { request, upstream } = input;
          if (upstream.protocol !== protocol)
            throw new HostError("adapter_mismatch", "Wrong upstream adapter");
          const key = upstream.credentialId
            ? (
                await host.call<{ secret: string }>(
                  "credentials.resolve@1",
                  {
                    id: upstream.credentialId,
                    userId: upstream.credentialOwner,
                  },
                  signal,
                )
              ).secret
            : host.secret(requiredString(upstream.keyRef, "upstream keyRef"));
          const body = host.hasCapability("ai.converter@1")
            ? await host.call(
                "ai.converter@1",
                { action: "encode", protocol, input: request },
                signal,
              )
            : encodeRequest(protocol, request);
          const url = new URL(
            requiredString(upstream.baseUrl, "upstream URL", 2048),
          );
          if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
          )
            throw new HostError(
              "invalid_upstream",
              "Invalid upstream base URL",
            );
          let suffix =
            protocol === "openai-chat"
              ? "/v1/chat/completions"
              : protocol === "openai-responses"
                ? "/v1/responses"
                : protocol === "anthropic"
                  ? "/v1/messages"
                  : "/v1beta/models/" +
                    encodeURIComponent(request.model.replace(/^models\//, "")) +
                    ":" +
                    (request.stream
                      ? "streamGenerateContent"
                      : "generateContent");
          let prefix = url.pathname.replace(/\/$/, "");
          if (suffix.startsWith("/v1/") && prefix.endsWith("/v1"))
            suffix = suffix.slice(3);
          if (suffix.startsWith("/v1beta/") && prefix.endsWith("/v1beta"))
            suffix = suffix.slice(7);
          url.pathname = prefix + suffix;
          if (protocol === "gemini" && request.stream)
            url.searchParams.set("alt", "sse");
          const headers: Record<string, string> = {
            "content-type": "application/json",
          };
          if (protocol === "anthropic") {
            headers["x-api-key"] = key;
            headers["anthropic-version"] = "2023-06-01";
          } else if (protocol === "gemini") headers["x-goog-api-key"] = key;
          else headers.authorization = "Bearer " + key;
          const response = await host.call<Response>(
            "http.transport@1",
            {
              url: url.href,
              headers,
              body: JSON.stringify(body),
              publicOnly: upstream.publicOnly,
            },
            signal,
          );
          if (!response.ok) {
            await response.body?.cancel();
            throw new HostError(
              "upstream_error",
              "Upstream rejected request",
              response.status === 429 ? 429 : 502,
            );
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
            return host.hasCapability("ai.converter@1")
              ? host.call(
                  "ai.converter@1",
                  { action: "decodeStream", protocol, input: response.body },
                  signal,
                )
              : upstreamEvents(protocol, response.body);
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
          const decoded = host.hasCapability("ai.converter@1")
            ? await host.call<AIResult>(
                "ai.converter@1",
                {
                  action: "decodeResult",
                  protocol,
                  input: data,
                  model: request.model,
                },
                signal,
              )
            : decodeResult(protocol, data, request.model);
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
