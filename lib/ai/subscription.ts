import { upstreamKey } from "./upstream-key.js";
import { prepareBeforeGeneration } from "./rejection.js";
import {
  definePlugin,
  HostError,
  requiredString,
  type Host,
} from "@pluhub/sdk";
import type { AIRequest, AIEvent, Upstream } from "@pluhub/contracts/ai";
import type {
  SubscriptionCredential,
  SubscriptionLease,
} from "@pluhub/contracts/subscription";
import { subscriptionRequest } from "./subscription-request.js";
import {
  subscriptionEvents,
  rejectedSubscription,
  SubscriptionFailure,
} from "./subscription-response.js";
import { cancelSSE } from "./sse.js";
import {
  subscriptionQuota,
  type SubscriptionKind,
} from "./subscription-auth.js";
import { discoverAntigravityProject } from "./antigravity-control.js";
import { prepareAntigravityRequest } from "./antigravity-reasoning.js";
export { subscriptionRequest } from "./subscription-request.js";
export type { SubscriptionKind } from "./subscription-auth.js";

async function* execute(
  host: Host,
  kind: SubscriptionKind,
  request: AIRequest,
  upstream: Upstream,
  signal: AbortSignal,
): AsyncGenerator<AIEvent> {
  if (kind === "antigravity") request = prepareAntigravityRequest(request);
  const ids = upstream.subscriptionAccountIds;
  if (
    ids &&
    ((upstream.credentialId && !upstream.credentialOwner) || upstream.keyRef)
  )
    throw new HostError(
      "subscription_binding",
      "Choose subscription accounts or a static credential",
    );
  const attempts = ids ? Math.min(3, ids.length) : 1;
  const attempted = new Set<string>();
  let failure: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let lease: SubscriptionLease | undefined;
    let credential:
      | {
          secret: string;
          accountId?: string;
          projectId?: string;
          version?: number;
          authMode?: "siwc";
        }
      | undefined;
    let body: ReadableStream<Uint8Array> | null | undefined;
    let delivered = false;
    let closing: Promise<void> | undefined;
    const detached = new AbortController().signal;
    const close = () =>
      (closing ??= (async () => {
        signal.removeEventListener("abort", onAbort);
        try {
          if (body) await cancelSSE(body);
        } finally {
          if (lease)
            await host.call(
              `ai.subscription.${kind}@1`,
              { action: "release", leaseId: lease.leaseId },
              detached,
            );
        }
      })());
    const onAbort = () => {
      void close().catch(() => {});
    };
    const report = (input: Record<string, unknown>) =>
      lease
        ? host.call(
            `ai.subscription.${kind}@1`,
            {
              action: "report",
              leaseId: lease.leaseId,
              version: credential?.version ?? lease.credential.version,
              ...input,
            },
            detached,
          )
        : Promise.resolve();
    try {
      if (ids) {
        lease = await host.call<SubscriptionLease>(
          `ai.subscription.${kind}@1`,
          {
            action: "acquire",
            provider: kind,
            ids,
            model: request.model,
            sessionId: request.sessionId,
            authMode: upstream.authMode,
            excludeIds: [...attempted],
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
        attempted.add(lease.accountId);
      }
      signal.addEventListener("abort", onAbort, { once: true });
      signal.throwIfAborted();
      credential =
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
                sessionId: request.sessionId,
              },
              signal,
            )
          : {
              secret: await prepareBeforeGeneration(() =>
                upstreamKey(host, upstream, signal, request.sessionId),
              ),
            });
      if (
        kind === "antigravity" &&
        !credential.projectId &&
        !upstream.projectId
      )
        credential = {
          ...credential,
          projectId: await discoverAntigravityProject(
            host,
            credential.secret,
            signal,
          ),
        };
      let prepared = prepareBeforeGeneration(() =>
        subscriptionRequest(kind, request, upstream, credential!),
      );
      const send = async () => {
        const response = await host.call<Response>(
          "http.transport@1",
          {
            url: prepared.url,
            headers: prepared.headers,
            body: JSON.stringify(prepared.body),
            publicOnly: upstream.publicOnly || !!lease,
          },
          signal,
        );
        body = response.body;
        signal.throwIfAborted();
        return response;
      };
      let refreshed = false;
      const refresh = async () => {
        refreshed = true;
        if (body) await cancelSSE(body);
        body = undefined;
        try {
          credential = await host.call<SubscriptionCredential>(
            `ai.subscription.${kind}@1`,
            {
              action: "refresh",
              leaseId: lease!.leaseId,
              version: credential!.version,
            },
            signal,
          );
        } catch (error) {
          signal.throwIfAborted();
          throw new SubscriptionFailure(
            error instanceof HostError &&
              error.code === "subscription_reauthorize"
              ? 401
              : 503,
          );
        }
        prepared = prepareBeforeGeneration(() =>
          subscriptionRequest(kind, request, upstream, credential!),
        );
      };
      for (;;) {
        const response = await send();
        if (response.status === 401 && lease && !refreshed) {
          await refresh();
          continue;
        }
        if (!response.ok) {
          const error = await rejectedSubscription(response, signal, kind);
          if (error.upstreamStatus === 401 && lease && !refreshed) {
            await refresh();
            continue;
          }
          throw error;
        }
        await report({
          status: response.status,
          quota: subscriptionQuota(kind, response.headers),
        });
        try {
          for await (const event of subscriptionEvents(
            kind,
            prepared.protocol,
            response,
            !!prepared.body.stream || request.stream,
            request.model,
            signal,
            request.operation,
          )) {
            signal.throwIfAborted();
            delivered = true;
            yield event;
          }
        } catch (error) {
          if (
            error instanceof SubscriptionFailure &&
            error.upstreamStatus === 401 &&
            !delivered &&
            lease &&
            !refreshed
          ) {
            await refresh();
            continue;
          }
          throw error;
        }
        return;
      }
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof SubscriptionFailure) {
        await report({
          status: error.upstreamStatus,
          retryAfter: error.retryAfter,
          quotaExhausted: error.quotaExhausted,
          resetAt: error.resetAt,
        });
        if (
          !delivered &&
          lease &&
          error.retryable &&
          attempt + 1 < attempts &&
          ids?.some((id) => !attempted.has(id))
        ) {
          failure = error;
          host.log(
            "warn",
            `订阅请求切换账号：${kind}/${lease.accountId} (${error.code})`,
          );
          continue;
        }
      }
      if (
        error instanceof HostError &&
        error.code === "subscription_unavailable" &&
        failure
      )
        throw failure;
      throw error;
    } finally {
      await close();
    }
  }
  throw (
    failure ??
    new HostError("subscription_unavailable", "暂无可用订阅账号", 503)
  );
}

export function createSubscription(kind: SubscriptionKind) {
  return definePlugin({
    setup(host) {
      for (const capability of [
        "ai.upstream." + kind + "@1",
        ...(kind === "codex" ? ["ai.media.codex@1"] : []),
      ])
        host.provide(
          capability,
          async (
            { request, upstream }: { request: AIRequest; upstream: Upstream },
            signal,
          ) => {
            if (upstream.protocol !== kind)
              throw new HostError(
                "adapter_mismatch",
                "Wrong subscription adapter",
              );
            const iterator = execute(host, kind, request, upstream, signal);
            // Resolve initial provider errors and failover before the ingress sends HTTP headers.
            let pending: IteratorResult<AIEvent> | undefined =
              await iterator.next();
            return {
              [Symbol.asyncIterator]() {
                return this;
              },
              next() {
                if (pending) {
                  const value = pending;
                  pending = undefined;
                  return Promise.resolve(value);
                }
                return iterator.next();
              },
              return() {
                pending = undefined;
                return iterator.return(undefined);
              },
              throw(error: unknown) {
                pending = undefined;
                return iterator.throw(error);
              },
            } satisfies AsyncIterableIterator<AIEvent>;
          },
        );
    },
  });
}
