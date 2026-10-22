import { randomUUID } from "node:crypto";
import { definePlugin, HostError, requiredString } from "@pluhub/sdk";
import type {
  AIRequest,
  AIEvent,
  Upstream,
  Protocol,
} from "@pluhub/contracts/ai";
import {
  encodeRequest,
  decodeResult,
  resultEvents,
  parseSSE,
  cancelSSE,
} from "./protocols.js";
import { upstreamEvents } from "./streams.js";
import { supportsOutputLimit } from "./output-budget.js";
import type {
  SubscriptionCredential,
  SubscriptionLease,
} from "@pluhub/contracts/subscription";
import {
  subscriptionDefaults,
  subscriptionQuota,
  type SubscriptionKind,
} from "./subscription-auth.js";
export type { SubscriptionKind } from "./subscription-auth.js";
export function subscriptionRequest(
  kind: SubscriptionKind,
  request: AIRequest,
  upstream: Upstream,
  credential: { secret: string; accountId?: string; projectId?: string },
) {
  const protocol: Protocol =
    kind === "codex"
      ? "openai-responses"
      : kind === "claude-subscription"
        ? "anthropic"
        : "gemini";
  let body: any = encodeRequest(protocol, request);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: "Bearer " + credential.secret,
  };
  const url = new URL(
    requiredString(
      upstream.baseUrl ||
        (upstream.subscriptionAccountIds
          ? subscriptionDefaults[kind].baseUrl
          : undefined),
      "subscription URL",
      2048,
    ),
  );
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new HostError(
      "invalid_upstream",
      "Invalid subscription upstream URL",
    );
  let suffix = "";
  if (kind === "codex") {
    suffix = "/responses";
    if (!supportsOutputLimit({ ...upstream, protocol: kind })) {
      if (request.maxTokens !== undefined || request.temperature !== undefined)
        throw new HostError(
          "unsupported_feature",
          "Codex CLI does not support output-token or temperature overrides; use SIWC or omit them",
        );
      body.stream = true;
      body.store = false;
      body.input = encodeRequest("openai-responses", {
        ...request,
        messages: request.messages.filter(
          (m) => m.role !== "system" && m.role !== "developer",
        ),
      }).input;
      body.instructions = request.messages
        .filter((m) => m.role === "system" || m.role === "developer")
        .map((m) => m.text)
        .join("\n");
      headers.originator = "codex-tui";
      headers["openai-beta"] = "responses=experimental";
    }
    const account = credential.accountId ?? upstream.accountId;
    if (account) headers["chatgpt-account-id"] = account;
  } else if (kind === "claude-subscription") {
    suffix = url.pathname.replace(/\/$/, "").endsWith("/v1")
      ? "/messages"
      : "/v1/messages";
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-beta"] =
      "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14";
  } else {
    const project = credential.projectId ?? upstream.projectId;
    if (!project)
      throw new HostError(
        "project_required",
        "Antigravity requires an authorized project ID",
      );
    suffix =
      "/v1internal:" +
      (request.stream ? "streamGenerateContent" : "generateContent");
    body = {
      project,
      model: request.model,
      userAgent: "antigravity",
      requestType: "agent",
      requestId: "agent-" + randomUUID(),
      request: {
        ...body,
        sessionId:
          "-" +
          String(BigInt("0x" + randomUUID().replaceAll("-", "").slice(0, 14))),
      },
    };
    delete body.request.model;
    if (request.stream) url.searchParams.set("alt", "sse");
  }
  url.pathname = url.pathname.replace(/\/$/, "") + suffix;
  return { url: url.href, headers, body, protocol };
}
function unwrapStream(body: ReadableStream<Uint8Array>) {
  const iterator = (async function* () {
    for await (const frame of parseSSE(body)) {
      if (frame.data === "[DONE]") {
        yield new TextEncoder().encode("data: [DONE]\n\n");
        continue;
      }
      const value = JSON.parse(frame.data);
      if (value.error)
        throw new HostError("upstream_error", "Antigravity stream error", 502);
      yield new TextEncoder().encode(
        "data: " + JSON.stringify(value.response ?? value) + "\n\n",
      );
    }
  })()[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>(
    {
      async pull(c) {
        try {
          const item = await iterator.next();
          if (item.done) c.close();
          else c.enqueue(item.value);
        } catch (e) {
          c.error(e);
        }
      },
      async cancel() {
        await cancelSSE(body);
        await iterator.return?.();
      },
    },
    { highWaterMark: 0 },
  );
}
export function createSubscription(kind: SubscriptionKind) {
  return definePlugin({
    setup(host) {
      host.provide(
        "ai.upstream." + kind + "@1",
        async (
          { request, upstream }: { request: AIRequest; upstream: Upstream },
          signal,
        ) => {
          if (upstream.protocol !== kind)
            throw new HostError(
              "adapter_mismatch",
              "Wrong subscription adapter",
            );
          let lease: SubscriptionLease | undefined;
          let responseBody: ReadableStream<Uint8Array> | null | undefined;
          const detached = new AbortController().signal;
          let released = false;
          const release = async () => {
            if (released) return;
            released = true;
            signal.removeEventListener("abort", onAbort);
            if (responseBody) await cancelSSE(responseBody);
            if (lease)
              await host.call(
                `ai.subscription.${kind}@1`,
                { action: "release", leaseId: lease.leaseId },
                detached,
              );
          };
          const onAbort = () => {
            void release().catch(() => {});
          };
          function managed(
            events: AsyncIterable<AIEvent>,
          ): AsyncIterableIterator<AIEvent> {
            const iterator = events[Symbol.asyncIterator]();
            return {
              [Symbol.asyncIterator]() {
                return this;
              },
              async next() {
                try {
                  signal.throwIfAborted();
                  const item = await iterator.next();
                  signal.throwIfAborted();
                  if (item.done) await release();
                  return item;
                } catch (error) {
                  await release();
                  throw error;
                }
              },
              async return() {
                try {
                  return (
                    (await iterator.return?.()) ?? {
                      done: true as const,
                      value: undefined,
                    }
                  );
                } finally {
                  await release();
                }
              },
              async throw(error) {
                try {
                  if (iterator.throw) return await iterator.throw(error);
                  throw error;
                } finally {
                  await release();
                }
              },
            };
          }
          try {
            if (upstream.subscriptionAccountIds) {
              if (
                (upstream.credentialId && !upstream.credentialOwner) ||
                upstream.keyRef
              )
                throw new HostError(
                  "subscription_binding",
                  "Choose subscription accounts or a static credential",
                );
              lease = await host.call<SubscriptionLease>(
                `ai.subscription.${kind}@1`,
                {
                  action: "acquire",
                  provider: kind,
                  ids: upstream.subscriptionAccountIds,
                  ...(upstream.credentialId
                    ? {
                        ownerId: requiredString(
                          upstream.credentialOwner,
                          "credential owner",
                        ),
                      }
                    : {}),
                },
                signal,
              );
              signal.addEventListener("abort", onAbort, { once: true });
              signal.throwIfAborted();
            }
            let credential =
              lease?.credential ??
              (upstream.credentialId
                ? await host.call<{
                    secret: string;
                    accountId?: string;
                    projectId?: string;
                  }>(
                    "credentials.resolve@1",
                    {
                      id: upstream.credentialId,
                      userId: upstream.credentialOwner,
                    },
                    signal,
                  )
                : {
                    secret: host.secret(
                      requiredString(upstream.keyRef, "subscription keyRef"),
                    ),
                  });
            let prepared = subscriptionRequest(
              kind,
              request,
              upstream,
              credential,
            );
            const send = () =>
              host.call<Response>(
                "http.transport@1",
                {
                  url: prepared.url,
                  headers: prepared.headers,
                  body: JSON.stringify(prepared.body),
                  publicOnly: upstream.publicOnly || !!lease,
                },
                signal,
              );
            let response = await send();
            responseBody = response.body;
            signal.throwIfAborted();
            if (response.status === 401 && lease) {
              await response.body?.cancel();
              credential = await host.call<SubscriptionCredential>(
                `ai.subscription.${kind}@1`,
                {
                  action: "refresh",
                  leaseId: lease.leaseId,
                  version: (credential as SubscriptionCredential).version,
                },
                signal,
              );
              prepared = subscriptionRequest(
                kind,
                request,
                upstream,
                credential,
              );
              response = await send();
              responseBody = response.body;
              signal.throwIfAborted();
            }
            if (lease)
              await host.call(
                `ai.subscription.${kind}@1`,
                {
                  action: "report",
                  leaseId: lease.leaseId,
                  version: (credential as SubscriptionCredential).version,
                  status: response.status,
                  retryAfter: response.headers.get("retry-after"),
                  quota: subscriptionQuota(kind, response.headers),
                },
                detached,
              );
            if (!response.ok) {
              await response.body?.cancel();
              throw new HostError(
                response.status === 429
                  ? "subscription_rate_limited"
                  : response.status === 401
                    ? "subscription_reauthorize"
                    : response.status === 403
                      ? "subscription_forbidden"
                      : "upstream_error",
                "Subscription upstream rejected request",
                response.status === 429 ? 429 : 502,
              );
            }
            if (!response.body)
              throw new HostError(
                "upstream_protocol",
                "Empty subscription response",
                502,
              );
            if (
              response.headers
                .get("content-type")
                ?.includes("text/event-stream")
            )
              return managed(
                upstreamEvents(
                  prepared.protocol,
                  kind === "antigravity"
                    ? unwrapStream(response.body)
                    : response.body,
                ),
              );
            if (prepared.body.stream || request.stream) {
              await response.body.cancel();
              throw new HostError(
                "upstream_protocol",
                "Expected subscription SSE response",
                502,
              );
            }
            const reader = response.body.getReader();
            const chunks: Uint8Array[] = [];
            let size = 0;
            try {
              for (;;) {
                signal.throwIfAborted();
                const item = await reader.read();
                if (item.done) break;
                size += item.value.length;
                if (size > 16777216) {
                  await reader.cancel();
                  throw new HostError(
                    "upstream_protocol",
                    "Response too large",
                    502,
                  );
                }
                chunks.push(item.value);
              }
            } catch (error) {
              await reader.cancel().catch(() => {});
              throw error;
            } finally {
              reader.releaseLock();
            }
            const raw = JSON.parse(Buffer.concat(chunks).toString());
            const data = kind === "antigravity" ? (raw.response ?? raw) : raw;
            const usage =
              kind === "antigravity" ? data.usageMetadata : data.usage;
            const fields =
              kind === "antigravity"
                ? ["promptTokenCount", "candidatesTokenCount"]
                : ["input_tokens", "output_tokens"];
            const known = fields.every(
              (k) => Number.isSafeInteger(usage?.[k]) && usage[k] >= 0,
            );
            return managed(
              (async function* () {
                for await (const event of resultEvents(
                  decodeResult(prepared.protocol, data, request.model),
                ))
                  if (event.type !== "usage" || known) yield event;
              })(),
            );
          } catch (error) {
            await release();
            throw error;
          }
        },
      );
    },
  });
}
