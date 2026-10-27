import { HostError } from "@pluhub/sdk";
import type { AIEvent, Protocol, MediaOperation } from "@pluhub/contracts/ai";
import { codexImageEvents } from "./codex-images.js";
import type { SubscriptionKind } from "./subscription-auth.js";
import { responseObject } from "./json-response.js";
import { parseSSE, cancelSSE } from "./sse.js";
import { decodeResult, resultEvents } from "./protocols.js";
import { upstreamEvents } from "./streams.js";
import { responseModel } from "./response-model.js";

export class SubscriptionFailure extends HostError {
  get generationRejected() {
    return [400, 401, 403, 404, 422, 429, 503].includes(this.upstreamStatus);
  }
  constructor(
    public upstreamStatus: number,
    public quotaExhausted = false,
    public retryAfter?: string | null,
    public resetAt?: number,
  ) {
    super(
      quotaExhausted
        ? "subscription_quota_exhausted"
        : upstreamStatus === 429
          ? "subscription_rate_limited"
          : upstreamStatus === 401
            ? "subscription_reauthorize"
            : upstreamStatus === 403
              ? "subscription_forbidden"
              : "upstream_error",
      quotaExhausted ? "订阅账号额度已用尽" : "订阅上游暂时不可用",
      upstreamStatus === 429 ? 429 : 502,
    );
  }
  get retryable() {
    return (
      [401, 403, 429].includes(this.upstreamStatus) ||
      this.upstreamStatus >= 500
    );
  }
}
function failure(
  raw: any,
  status = 502,
  retryAfter?: string | null,
  provider?: SubscriptionKind,
) {
  const error = raw?.error ?? raw?.response?.error ?? raw ?? {};
  const kind =
    typeof error === "string"
      ? error
      : [error.type, error.code, error.status]
          .filter((v) => typeof v === "string")
          .join(" ");
  const message = typeof error.message === "string" ? error.message : "";
  const grokCode =
    provider === "grok" ? JSON.stringify(raw ?? {}).toLowerCase() : "";
  const grokExhausted = /free-usage-exhausted|included free usage/.test(
    grokCode,
  );
  if (
    provider === "grok" &&
    /bad-credentials|access token could not be validated/.test(grokCode)
  )
    status = 401;
  if (grokExhausted) retryAfter ??= "86400";
  const exhausted =
    grokExhausted ||
    /usage_limit|insufficient_quota|quota_exceeded|credit_balance|daily_limit|weekly_limit/i.test(
      kind,
    ) ||
    /quota.{0,80}(exhaust|exceed|insuff)|(?:exhaust|exceed).{0,80}quota|usage limit|credit balance|daily limit|weekly limit/i.test(
      message,
    );
  if (exhausted || /rate_limit|RESOURCE_EXHAUSTED/i.test(kind)) status = 429;
  else if (
    /UNAUTHENTICATED|authentication_error|invalid_token|invalid_api_key/i.test(
      kind,
    )
  )
    status = 401;
  else if (/PERMISSION_DENIED|permission_error/i.test(kind)) status = 403;
  else if (
    Number.isInteger(error.code) &&
    error.code >= 400 &&
    error.code <= 599
  )
    status = error.code;
  const reset = error.resets_at ?? error.reset_at ?? error.resetAt;
  const delay = error.resets_in_seconds ?? error.retry_after;
  let resetAt =
    typeof reset === "number"
      ? reset < 100000000000
        ? reset * 1000
        : reset
      : typeof reset === "string"
        ? Date.parse(reset)
        : undefined;
  if (resetAt === undefined && typeof delay === "number")
    resetAt = Date.now() + delay * 1000;
  for (const detail of Array.isArray(error.details) ? error.details : []) {
    const seconds =
      typeof detail.retryDelay === "string"
        ? /^(\d+(?:\.\d+)?)s$/.exec(detail.retryDelay)?.[1]
        : undefined;
    if (seconds) retryAfter ??= seconds;
  }
  if (resetAt === undefined && retryAfter) {
    resetAt = /^\d+(\.\d+)?$/.test(retryAfter)
      ? Date.now() + Number(retryAfter) * 1000
      : Date.parse(retryAfter);
  }
  if (
    !Number.isFinite(resetAt) ||
    resetAt! < Date.now() ||
    resetAt! > Date.now() + 366 * 86400000
  )
    resetAt = undefined;
  return new SubscriptionFailure(status, exhausted, retryAfter, resetAt);
}
export async function rejectedSubscription(
  response: Response,
  signal: AbortSignal,
  kind?: SubscriptionKind,
) {
  let raw: unknown;
  try {
    raw = await responseObject(response, signal);
  } catch {
    signal.throwIfAborted();
  }
  return failure(
    raw,
    response.status,
    response.headers.get("retry-after"),
    kind,
  );
}
function streamBody(
  kind: SubscriptionKind,
  body: ReadableStream<Uint8Array>,
  maximum?: number,
) {
  const iterator = (async function* () {
    const encoder = new TextEncoder();
    for await (const frame of parseSSE(body, maximum)) {
      if (frame.data === "[DONE]") {
        yield encoder.encode("data: [DONE]\n\n");
        continue;
      }
      const value = JSON.parse(frame.data);
      if (
        value.error ||
        value.response?.error ||
        value.type === "error" ||
        value.type === "response.failed"
      )
        throw failure(value, 502, undefined, kind);
      const data = kind === "antigravity" ? (value.response ?? value) : value;
      yield encoder.encode(
        `event: ${frame.event}\ndata: ${JSON.stringify(data)}\n\n`,
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
        } catch (error) {
          c.error(error);
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
export async function* subscriptionEvents(
  kind: SubscriptionKind,
  protocol: Protocol,
  response: Response,
  expectedStream: boolean,
  model: string,
  signal: AbortSignal,
  operation?: MediaOperation,
): AsyncGenerator<AIEvent> {
  if (!response.body)
    throw new HostError(
      "upstream_protocol",
      "Empty subscription response",
      502,
    );
  const contentType = response.headers.get("content-type");
  if (
    contentType?.includes("text/event-stream") ||
    (kind === "codex" && expectedStream && !contentType)
  ) {
    if (kind === "codex" && operation) {
      yield* codexImageEvents(
        streamBody(kind, response.body, 64 * 1024 * 1024),
        model,
        !!operation.input.stream,
        typeof operation.input.output_format === "string"
          ? operation.input.output_format
          : "png",
      );
      return;
    }
    yield* upstreamEvents(protocol, streamBody(kind, response.body));
    return;
  }
  // Some gateways return a JSON error with HTTP 200 even when streaming was requested.
  const raw = await responseObject(response, signal, 16 * 1024 * 1024);
  const data = kind === "antigravity" ? (raw.response ?? raw) : raw;
  if (data.error) throw failure(data, 502, undefined, kind);
  if (expectedStream)
    throw new HostError(
      "upstream_protocol",
      "Expected subscription SSE response",
      502,
    );
  const usage = kind === "antigravity" ? data.usageMetadata : data.usage;
  const fields =
    kind === "antigravity"
      ? ["promptTokenCount", "candidatesTokenCount"]
      : ["input_tokens", "output_tokens"];
  const known = fields.every(
    (k) => Number.isSafeInteger(usage?.[k]) && usage[k] >= 0,
  );
  const decoded = decodeResult(protocol, data, model);
  const upstreamModel = responseModel(protocol, data);
  if (upstreamModel) yield { type: "upstream-model", model: upstreamModel };
  for await (const event of resultEvents(decoded))
    if (event.type !== "usage" || known) yield event;
}
