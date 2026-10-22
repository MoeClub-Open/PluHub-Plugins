import { setTimeout } from "node:timers/promises";
// Pull-driven pacing; cancellation interrupts both sleep and upstream reads.
export function throttle(
  body: ReadableStream<Uint8Array>,
  bytesPerSecond: number,
  signal: AbortSignal,
) {
  const reader = body.getReader();
  const local = new AbortController();
  const combined = AbortSignal.any([signal, local.signal]);
  let chunk: Uint8Array | undefined;
  let offset = 0;
  let next = performance.now();
  let closed = false;
  const abort = () => {
    void reader.cancel(combined.reason).catch(() => {});
  };
  combined.addEventListener("abort", abort, { once: true });
  return new ReadableStream<Uint8Array>(
    {
      async pull(c) {
        try {
          combined.throwIfAborted();
          if (!chunk || offset === chunk.length) {
            const item = await reader.read();
            if (closed) return;
            if (item.done) {
              closed = true;
              combined.removeEventListener("abort", abort);
              reader.releaseLock();
              c.close();
              return;
            }
            chunk = item.value;
            offset = 0;
          }
          const part = chunk.subarray(
            offset,
            offset + Math.max(1, Math.min(16384, bytesPerSecond / 10)),
          );
          const wait = next - performance.now();
          if (wait > 0) await setTimeout(wait, undefined, { signal: combined });
          combined.throwIfAborted();
          if (closed) return;
          offset += part.length;
          next =
            Math.max(next, performance.now()) +
            (part.length / bytesPerSecond) * 1000;
          c.enqueue(part);
        } catch (e) {
          if (!closed) {
            closed = true;
            c.error(e);
          }
          combined.removeEventListener("abort", abort);
          await reader.cancel(e).catch(() => {});
        }
      },
      async cancel(reason) {
        closed = true;
        local.abort(reason);
        combined.removeEventListener("abort", abort);
        await reader.cancel(reason).catch(() => {});
      },
    },
    { highWaterMark: 0 },
  );
}
