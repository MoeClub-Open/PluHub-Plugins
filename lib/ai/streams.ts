import type { AIEvent, Protocol } from "@pluhub/contracts/ai";
import { decodeEvents } from "./stream-events.js";
import { frame, wire } from "./wire.js";
import { cancelSSE } from "./sse.js";
import { streamError } from "./stream-error.js";
export function upstreamEvents(
  protocol: Protocol,
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<AIEvent> {
  const iterator = decodeEvents(protocol, body);
  const close = async () => {
    if (!body.locked) await body.cancel().catch(() => {});
  };
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next(...args: [] | [undefined]) {
      try {
        const result = await iterator.next(...args);
        if (result.done) await close();
        return result;
      } catch (error) {
        await close();
        throw error;
      }
    },
    async return(value) {
      await cancelSSE(body);
      try {
        return await iterator.return(value);
      } finally {
        await close();
      }
    },
    async throw(error) {
      await cancelSSE(body);
      try {
        return await iterator.throw(error);
      } finally {
        await close();
      }
    },
    [Symbol.asyncDispose]() {
      return this.return(undefined).then(() => {});
    },
  };
}
export function encodeStream(
  protocol: Protocol,
  events: AsyncIterable<AIEvent>,
  model: string,
  signal: AbortSignal,
  options: {
    onError?: (error: unknown) => void;
    onCancel?: (reason: unknown) => void;
  } = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let sequence = 0;
  const source = events[Symbol.asyncIterator]();
  let sourceClosed = false;
  const closeSource = async () => {
    if (!sourceClosed) {
      sourceClosed = true;
      await source.return?.();
    }
  };
  const shared: AsyncIterable<AIEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: () => source.next(),
      return: async () => {
        await closeSource();
        return { done: true, value: undefined };
      },
    }),
  };
  const iterator = wire(protocol, shared, model, options.onError)[
    Symbol.asyncIterator
  ]();
  let closed = false;
  let abort: () => void;
  const detach = () => signal.removeEventListener("abort", abort);
  return new ReadableStream({
    start(controller) {
      abort = () => {
        if (closed) return;
        options.onError?.(signal.reason);
        options.onCancel?.(signal.reason);
        // Allow an outer reader's synchronous cancel() to take ownership first.
        // Otherwise the abort would error its inner reader just before cancel().
        queueMicrotask(() => {
          if (closed) return;
          closed = true;
          controller.error(signal.reason);
          detach();
          void closeSource()
            .then(() => iterator.return?.(undefined))
            .catch(() => {});
        });
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(controller) {
      try {
        signal.throwIfAborted();
        const result = await iterator.next();
        if (closed) return;
        if (result.done) {
          closed = true;
          detach();
          controller.close();
        } else {
          sequence++;
          controller.enqueue(encoder.encode(result.value));
        }
      } catch (cause) {
        if (closed) return;
        options.onError?.(cause);
        options.onCancel?.(cause);
        detach();
        if (signal.aborted) {
          closed = true;
          controller.error(signal.reason);
          await closeSource();
          await iterator.return?.(undefined);
          return;
        }
        const safe = streamError(cause);
        const error = {
          type: "api_error",
          message: safe.message,
          ...(safe.code === "upstream_budget_exceeded"
            ? { code: safe.code }
            : {}),
        };
        const data =
          protocol === "anthropic"
            ? { type: "error", error }
            : protocol === "openai-responses"
              ? {
                  type: "error",
                  sequence_number: sequence,
                  code: safe.code,
                  message: error.message,
                  param: null,
                }
              : protocol === "gemini"
                ? {
                    error: {
                      code: 502,
                      message: error.message,
                      status: "UNAVAILABLE",
                      ...(safe.code === "upstream_budget_exceeded"
                        ? {
                            details: [
                              {
                                "@type":
                                  "type.googleapis.com/google.rpc.ErrorInfo",
                                reason: safe.code,
                                domain: "pluhub",
                              },
                            ],
                          }
                        : {}),
                    },
                  }
                : { error: { ...error, code: safe.code } };
        controller.enqueue(
          encoder.encode(
            frame(
              data,
              ["anthropic", "openai-responses"].includes(protocol)
                ? "error"
                : undefined,
            ),
          ),
        );
        controller.close();
        closed = true;
        await closeSource();
        await iterator.return?.(undefined);
      }
    },
    async cancel(reason) {
      closed = true;
      detach();
      options.onError?.(reason ?? new Error("Client cancelled stream"));
      options.onCancel?.(reason);
      await closeSource();
      await iterator.return?.(undefined);
    },
  });
}
