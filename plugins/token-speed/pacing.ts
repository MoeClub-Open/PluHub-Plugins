import { setTimeout as delay } from "node:timers/promises";
import { HostError } from "@pluhub/sdk";
import type { AIEvent } from "@pluhub/contracts/ai";
interface Job {
  cost: number;
  signal: AbortSignal;
  resolve: () => void;
  reject: (e: unknown) => void;
  abort: () => void;
}
/** FIFO leaky scheduler: no initial token burst, aborted queued jobs consume no future budget. */
export class TokenPacer {
  private next = 0;
  private queue: Job[] = [];
  private running = false;
  constructor(
    private rate: () => number,
    private now: () => number = () => performance.now(),
    private sleep: (ms: number, signal: AbortSignal) => Promise<void> = async (
      ms,
      s,
    ) => {
      if (ms > 0) await delay(ms, undefined, { signal: s });
    },
  ) {
    this.next = this.now();
  }
  take(cost: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (cost <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const job: Job = {
        cost,
        signal,
        resolve,
        reject,
        abort: () => {
          const i = this.queue.indexOf(job);
          if (i >= 0) {
            this.queue.splice(i, 1);
            signal.removeEventListener("abort", job.abort);
            reject(signal.reason);
          }
        },
      };
      signal.addEventListener("abort", job.abort, { once: true });
      this.queue.push(job);
      void this.run();
    });
  }
  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!;
        try {
          job.signal.throwIfAborted();
          const rate = this.rate();
          if (!Number.isFinite(rate) || rate <= 0)
            throw new Error("Invalid TPS rate");
          const deadline =
            Math.max(this.next, this.now()) + (job.cost * 1000) / rate;
          await this.sleep(Math.max(0, deadline - this.now()), job.signal);
          job.signal.throwIfAborted();
          this.next = deadline;
          job.resolve();
        } catch (e) {
          job.reject(e);
        } finally {
          job.signal.removeEventListener("abort", job.abort);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
export async function* paceEvents(
  events: AsyncIterable<AIEvent>,
  count: (text: string) => number,
  take: (cost: number) => Promise<void>,
  signal: AbortSignal,
  maxTrackedChars = 65536,
  quantum = 1,
): AsyncGenerator<AIEvent> {
  const prefixes = new Map<string, { text: string; high: number }>();
  let tracked = 0;
  let charged = 0;
  let knownOutput: number | undefined;
  async function* fragments(
    key: string,
    value: string,
  ): AsyncGenerator<string> {
    const state = prefixes.get(key) ?? { text: "", high: 0 };
    prefixes.set(key, state);
    const points = Array.from(value);
    let index = 0;
    while (index < points.length) {
      signal.throwIfAborted();
      let lo = index + 1,
        hi = points.length,
        best = index + 1;
      // Tokenize complete prefixes to avoid interpreting transport chunks as tokens.
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const text = points.slice(index, mid).join("");
        if (tracked + text.length > maxTrackedChars) {
          hi = mid - 1;
          continue;
        }
        const n = count(state.text + text);
        if (n - state.high <= quantum) {
          best = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      const text = points.slice(index, best).join("");
      if (tracked + text.length > maxTrackedChars)
        throw new HostError(
          "token_tracking_limit",
          "Output exceeds configured tokenizer tracking limit",
          502,
        );
      const n = count(state.text + text);
      if (!Number.isSafeInteger(n) || n < 0)
        throw new HostError(
          "tokenizer_error",
          "Tokenizer returned an invalid count",
          502,
        );
      const cost = Math.max(0, n - state.high);
      await take(cost);
      signal.throwIfAborted();
      charged += cost;
      tracked += text.length;
      state.text += text;
      state.high = Math.max(state.high, n);
      index = best;
      yield text;
    }
  }
  for await (const event of events) {
    signal.throwIfAborted();
    if (event.type === "text" || event.type === "refusal") {
      for await (const text of fragments("text", event.text))
        yield { ...event, text };
    } else if (event.type === "reasoning") {
      let sent = false;
      for await (const text of fragments(
        "reasoning:" + event.index,
        event.text,
      )) {
        yield {
          ...event,
          text,
          signature: undefined,
          encrypted: undefined,
          redacted: undefined,
        };
        sent = true;
      }
      if (!sent || event.signature || event.encrypted || event.redacted)
        yield { ...event, text: "" };
    } else if (event.type === "tool") {
      let first = true;
      const args = event.arguments ?? "";
      if (event.name) {
        for await (const _ of fragments(
          "tool-name:" + event.index,
          event.name,
        )) {
          // Account before emitting the complete name required by start frames.
        }
        yield {
          type: "tool",
          index: event.index,
          ...(event.id ? { id: event.id } : {}),
          name: event.name,
        };
        first = false;
      }
      for await (const part of fragments("tool-args:" + event.index, args)) {
        yield {
          type: "tool",
          index: event.index,
          ...(first && event.id ? { id: event.id } : {}),
          arguments: part,
        };
        first = false;
      }
      if (first) yield event;
      else if (event.done || event.thoughtSignature)
        yield {
          type: "tool",
          index: event.index,
          ...(event.done ? { done: true } : {}),
          ...(event.thoughtSignature
            ? { thoughtSignature: event.thoughtSignature }
            : {}),
        };
    } else {
      if (
        event.type === "usage" &&
        Number.isSafeInteger(event.usage.output) &&
        event.usage.output >= 0
      )
        knownOutput = Math.max(knownOutput ?? 0, event.usage.output);
      // Reconcile hidden reasoning/output tokens before making the terminal event visible.
      if (
        event.type === "finish" &&
        knownOutput !== undefined &&
        knownOutput > charged
      ) {
        await take(knownOutput - charged);
        charged = knownOutput;
      }
      yield event;
    }
  }
}
