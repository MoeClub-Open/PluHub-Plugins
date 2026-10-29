import { expect, it } from "vitest";
import { executeRequest } from "../lib/ai/execution.js";
import { observeEvents } from "../lib/ai/telemetry.js";
import { encodeStream } from "../lib/ai/streams.js";

it.each([false, true])(
  "runs an admitted asynchronous fallback without charging its parent (%s)",
  async (streaming) => {
    const signal = new AbortController().signal;
    const calls: string[] = [];
    const state = new Map<string, any>([
      ["ai.observation", { startedAt: Date.now(), protocol: "openai-chat" }],
    ]);
    const ctx = { state } as any;
    const request = {
      model: "public",
      messages: [],
      tools: [],
      stream: streaming,
    } as any;
    const plan = {
      kind: "provider",
      capability: "primary",
      upstream: {},
      model: "primary",
      fallback: {},
    } as any;
    const host = {
      hasCapability: (name: string) =>
        ["billing.admit@1", "ai.workflow-execution@1"].includes(name),
      async call(name: string, input?: any) {
        calls.push(name);
        if (name === "ai.execution@1")
          return (async function* () {
            throw Object.assign(new Error("rejected"), {
              generationRejected: true,
              retryable: true,
            });
          })();
        if (name === "ai.routing@3")
          return {
            kind: "workflow",
            model: "public",
            workflowDeferred: { input: {}, requestedModel: "public" },
          };
        if (name === "billing.admit@1" || name === "ai.request-limits@1") {
          expect(input.retry).toBe(true);
          return;
        }
        if (name === "ai.workflow-execution@1") {
          expect(state.get("workflow.ready")).toBe(true);
          expect(state.get("ai.executionRejected")).toBe(false);
          if (streaming) {
            const source = (async function* () {
              yield { type: "text" as const, text: "ok" };
              yield { type: "usage" as const, usage: { input: 4, output: 2 } };
              yield { type: "finish" as const, reason: "stop" as const };
            })();
            return new Response(
              encodeStream("openai-chat", source, "public", signal),
            );
          }
          return Response.json({
            id: "response",
            model: "public",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 4, completion_tokens: 2 },
          });
        }
        throw new Error(name);
      },
    };
    const events = await executeRequest(
      host as any,
      ctx,
      request,
      plan,
      signal,
    );
    const observed = [];
    for await (const event of observeEvents(events, ctx)) observed.push(event);
    expect(observed.map((item) => item.type)).toEqual([
      "text",
      "usage",
      "finish",
    ]);
    expect(state.get("ai.observation").usage).toBeUndefined();
    expect(state.get("ai.observation").finished).toBe(true);
    expect(state.get("workflow.forwardUsage")).toBe(true);
    expect(calls).toEqual([
      "ai.execution@1",
      "ai.routing@3",
      "ai.request-limits@1",
      "billing.admit@1",
      "ai.workflow-execution@1",
    ]);
  },
);

it("cancels the asynchronous fallback stream when the client stops reading", async () => {
  const signal = new AbortController().signal;
  let closed = false;
  const state = new Map<string, any>([
    ["ai.observation", { startedAt: Date.now(), protocol: "openai-chat" }],
  ]);
  const request = {
    model: "public",
    messages: [],
    tools: [],
    stream: true,
  } as any;
  const plan = {
    kind: "provider",
    capability: "primary",
    upstream: {},
    model: "primary",
    fallback: {},
  } as any;
  const host = {
    hasCapability: (name: string) => name === "ai.workflow-execution@1",
    async call(name: string) {
      if (name === "ai.execution@1")
        return (async function* () {
          throw Object.assign(new Error("rejected"), {
            generationRejected: true,
            retryable: true,
          });
        })();
      if (name === "ai.routing@3")
        return {
          kind: "workflow",
          model: "public",
          workflowDeferred: { input: {}, requestedModel: "public" },
        };
      if (name === "ai.request-limits@1") return;
      if (name === "ai.workflow-execution@1") {
        const source = (async function* () {
          try {
            yield { type: "text" as const, text: "ok" };
          } finally {
            closed = true;
          }
        })();
        return new Response(
          encodeStream("openai-chat", source, "public", signal),
        );
      }
      throw new Error(name);
    },
  };
  const events = await executeRequest(
    host as any,
    { state } as any,
    request,
    plan,
    signal,
  );
  const iterator = events[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toMatchObject({
    type: "text",
    text: "ok",
  });
  await iterator.return?.();
  expect(closed).toBe(true);
});
