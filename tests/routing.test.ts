import { it, expect, afterEach } from "vitest";
import type { AIRequest, AIEvent, RequestPricing } from "@pluhub/contracts/ai";
import type { RoutingProfile } from "@pluhub/contracts/routing";
import { HostError } from "@pluhub/sdk";
import router from "../plugins/auto-router/index.js";
import {
  decisionBody,
  parseDecision,
  decide,
} from "../plugins/auto-router/decisions.js";
import { decodeReasoning, encodeReasoning } from "../lib/ai/reasoning.js";
import { decodeResult } from "../lib/ai/protocols.js";
import { encodeStream, upstreamEvents } from "../lib/ai/streams.js";
import { TokenPacer, paceEvents } from "../plugins/token-speed/pacing.js";
import { getEncoding } from "js-tiktoken";

const signal = () => new AbortController().signal;
const request = (text = "hello"): AIRequest => ({
  model: "auto",
  messages: [{ role: "user", text }],
  tools: [],
  stream: true,
});
const dist = { easy: 0.01, standard: 0.08, hard: 0.9, expert: 0.01 };
const answer = (confidence = 0.82) => ({
  answers: [
    {
      name: "difficulty",
      choice: "hard",
      probabilities: Object.entries(dist).map(([value, probability]) => ({
        value,
        probability,
      })),
      confidence,
    },
  ],
});
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
function harness(
  profile: Partial<RoutingProfile> = {},
  prices?: Record<string, RequestPricing>,
) {
  const p: RoutingProfile = {
    mode: "both",
    decision: { kind: "rules" },
    onFailure: "fallback",
    fallbackCandidate: "strong",
    candidates: [
      {
        id: "fast",
        target: "fast",
        strength: 30,
        reasoningEfforts: ["low", "medium"],
      },
      {
        id: "strong",
        target: "strong",
        strength: 95,
        reasoningEfforts: ["low", "medium", "high", "max"],
      },
    ],
    ...profile,
  };
  const handlers = new Map<string, any>();
  let validate: (c: any) => void = () => {};
  const config = { profiles: { smart: p }, secretRefs: ["env:DECISION"] };
  let calls = 0;
  const host: any = {
    config: () => config,
    cleanup: (fn: any) => cleanup.push(fn),
    validateConfig: (fn: any) => (validate = fn),
    provide: (n: string, fn: any) => handlers.set(n, fn),
    api: () => {},
    secret: () => "decision-only",
    call: async (n: string, i: any, s: AbortSignal) => {
      s.throwIfAborted();
      if (n === "ai.targets@1")
        return {
          plan: {
            capability: "ai.upstream.openai-chat@1",
            upstream: { protocol: "openai-chat" },
            upstreamId: i.target,
            model: i.target + "-vendor",
            targetModelId: i.target,
            pricing: prices?.[i.target] ?? {
              input: 1,
              output: i.target === "fast" ? 1 : 10,
            },
          },
          route: { upstream: i.target, model: i.target + "-vendor" },
        };
      if (n === "credentials.select@1") {
        if (i.channel !== "strong")
          throw new HostError("credential_channel", "wrong channel");
        return {};
      }
      if (n === "http.transport@1") {
        calls++;
        return Response.json(answer());
      }
      throw Error(n);
    },
  };
  router.setup(host);
  validate(config);
  return {
    p,
    config,
    host,
    handlers,
    validate,
    calls: () => calls,
    resolve: (r = request(), s = signal(), extra = {}) =>
      handlers.get("ai.auto-routing@1")(
        { profile: "smart", request: r, ...extra },
        s,
      ),
  };
}

it("ranks routing candidates using request prices, channel multipliers and context tiers", async () => {
  for (const [prices, expected] of [
    [
      {
        fast: { mode: "request", request: 1, input: 0, output: 0 },
        strong: { input: 1, output: 10 },
      },
      "strong",
    ],
    [
      {
        fast: { input: 100, output: 100, multiplier: 0.001 },
        strong: { input: 1, output: 1 },
      },
      "fast",
    ],
    [
      {
        fast: {
          input: 0.1,
          output: 0.1,
          tiers: [{ above: 0, input: 100, output: 100 }],
        },
        strong: { input: 1, output: 1 },
      },
      "strong",
    ],
  ] as [Record<string, RequestPricing>, string][]) {
    const h = harness({ mode: "model", strategy: "cost" }, prices);
    expect((await h.resolve()).targetModelId).toBe(expected);
  }
});

it("uses three distinct native decision envelopes and validates confidence and distributions", () => {
  expect(decisionBody("luna", "gpt-6-luna", { task: "x" })).toMatchObject({
    model: "gpt-6-luna",
    questions: [{ type: "choice", name: "difficulty" }],
  });
  expect(decisionBody("systemone", "Cloudflare/clef", {})).toMatchObject({
    questions: { difficulty: { criteria: { expert: expect.any(String) } } },
  });
  expect(decisionBody("jev", "ignored", {})).toMatchObject({
    kind: "choice",
    options: ["easy", "standard", "hard", "expert"],
  });
  expect(decisionBody("jev", "ignored", {})).not.toHaveProperty("model");
  expect(parseDecision("luna", answer()).confidence).toBe(0.82);
  expect(
    parseDecision("systemone", {
      answers: { difficulty: { choice: "hard", probabilities: dist } },
    }).difficulty,
  ).toBe("hard");
  expect(
    parseDecision("jev", {
      options: Object.keys(dist),
      probabilities: Object.values(dist),
      choice: "hard",
      choice_index: 2,
    }).confidence,
  ).toBe(0.9);
  for (const body of [
    answer(-1),
    { answers: [{ ...answer().answers[0], choice: "easy" }] },
    {
      answers: [
        {
          ...answer().answers[0],
          probabilities: [{ value: "hard", probability: 1 }],
        },
      ],
    },
  ])
    expect(() => parseDecision("luna", body)).toThrow();
});
it.each([
  ["luna", "decisions"],
  ["systemone", "systemone"],
  ["jev", "decide"],
] as const)(
  "calls %s native endpoint with separate credentials",
  async (kind, path) => {
    let sent: any;
    const host: any = {
      secret: () => "classifier",
      call: async (_: string, i: any) => {
        sent = i;
        return Response.json(
          kind === "luna"
            ? answer()
            : kind === "systemone"
              ? {
                  answers: {
                    difficulty: { choice: "hard", probabilities: dist },
                  },
                }
              : {
                  choice: "hard",
                  options: Object.keys(dist),
                  probabilities: Object.values(dist),
                },
        );
      },
    };
    expect(
      (
        await decide(
          host,
          {
            kind,
            model: "m",
            baseUrl: "https://decision.example/v1",
            keyRef: "env:D",
          },
          request(),
          signal(),
        )
      ).difficulty,
    ).toBe("hard");
    expect(sent.url).toBe("https://decision.example/v1/" + path);
    expect(sent.headers.authorization).toBe("Bearer classifier");
  },
);
it("selects models by difficulty and applies strength updates without restart", async () => {
  const h = harness();
  expect(await h.resolve()).toMatchObject({
    model: "fast-vendor",
    reasoning: { effort: "low" },
  });
  expect(
    await h.resolve(request("x".repeat(2000) + " 调试算法")),
  ).toMatchObject({ model: "strong-vendor", reasoning: { effort: "high" } });
  h.p.candidates[0]!.strength = 100;
  expect((await h.resolve()).model).toBe("strong-vendor");
});
it("supports model-only, effort-only and manual modes and explicit client effort", async () => {
  const h = harness({ mode: "model" });
  const r = { ...request(), reasoning: { effort: "high" as const } };
  expect(await h.resolve(r)).toMatchObject({
    model: "strong-vendor",
    reasoning: { effort: "high" },
  });
  h.p.mode = "effort";
  h.p.fixedCandidate = "strong";
  expect(await h.resolve()).toMatchObject({
    model: "strong-vendor",
    reasoning: { effort: "low" },
  });
  h.p.mode = "manual";
  h.p.fixedEffort = "max";
  expect(await h.resolve()).toMatchObject({
    reasoning: { effort: "max" },
    decision: { source: "manual" },
  });
});
it("falls back or rejects low confidence, truncation and service failures", async () => {
  const h = harness({
    decision: { kind: "luna", baseUrl: "https://decision.example", model: "m" },
  });
  h.host.call = async () => Response.json(answer(0.1));
  // Keep real target resolver and replace only transport.
  const transport = h.host.call;
  const original = harness().host.call;
  h.host.call = (n: string, i: any, s: AbortSignal) =>
    n === "http.transport@1" ? transport() : original(n, i, s);
  expect(await h.resolve()).toMatchObject({
    model: "strong-vendor",
    reasoning: { effort: "high" },
    decision: { fallback: "decision_confidence" },
  });
  h.p.onFailure = "reject";
  await expect(h.resolve()).rejects.toMatchObject({
    code: "decision_confidence",
  });
  h.p.onFailure = "fallback";
  h.p.decision.maxInputChars = 128;
  h.host.call = (n: string, i: any, s: AbortSignal) =>
    n === "http.transport@1"
      ? Promise.resolve(Response.json(answer()))
      : original(n, i, s);
  expect((await h.resolve(request("a".repeat(300)))).decision.fallback).toBe(
    "decision_truncated",
  );
  h.host.call = (n: string, i: any, s: AbortSignal) =>
    n === "http.transport@1"
      ? Promise.reject(Error("offline"))
      : original(n, i, s);
  expect((await h.resolve()).decision.source).toBe("fallback");
});
it("propagates cancellation and filters BYOK channels before deciding", async () => {
  const h = harness();
  expect(
    (
      await h.resolve(request(), signal(), {
        credentialId: "byok",
        principalId: "owner",
      })
    ).upstreamId,
  ).toBe("strong");
  const c = new AbortController();
  c.abort();
  await expect(h.resolve(request(), c.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  h.p.mode = "effort";
  h.p.fixedCandidate = "fast";
  await expect(
    h.resolve(request(), signal(), {
      credentialId: "byok",
      principalId: "owner",
    }),
  ).rejects.toMatchObject({ code: "no_route" });
});
it("rejects invalid fixed policies and rate limits the remote classifier independently", async () => {
  const h = harness({
    decision: { kind: "luna", baseUrl: "https://decision.example", model: "m" },
  });
  expect(() =>
    h.validate({
      profiles: { bad: { ...h.p, mode: "effort", fixedCandidate: "missing" } },
    }),
  ).toThrow();
  expect(() =>
    h.validate({
      profiles: {
        bad: { ...h.p, candidates: [h.p.candidates[0], h.p.candidates[0]] },
      },
    }),
  ).toThrow();
  (h.config as any).decisionRpm = 1;
  await h.resolve();
  await expect(h.resolve()).rejects.toMatchObject({
    code: "decision_rate_limited",
    status: 429,
  });
  expect(h.calls()).toBe(1);
});
it("filters protocol-inexpressible effort and budget combinations before selection", async () => {
  const h = harness();
  const original = h.host.call;
  h.host.call = async (n: string, i: any, s: AbortSignal) => {
    const v = await original(n, i, s);
    if (n === "ai.targets@1")
      v.plan.upstream.protocol = i.target === "fast" ? "gemini" : "anthropic";
    return v;
  };
  const req = { ...request(), reasoning: { effort: "max" as const } };
  expect((await h.resolve(req)).model).toBe("strong-vendor");
  h.p.mode = "model";
  expect(
    await h.resolve({ ...request(), reasoning: { budgetTokens: 2048 } }),
  ).toMatchObject({ model: "fast-vendor", reasoning: { budgetTokens: 2048 } });
  h.host.call = original;
  await expect(
    h.resolve({ ...request(), reasoning: { budgetTokens: 2048 } }),
  ).rejects.toMatchObject({ code: "no_route" });
});
it("never exposes private Anthropic or Gemini thought deltas", async () => {
  const cases = [
    {
      protocol: "anthropic" as const,
      frames: [
        { type: "message_start", message: { usage: { input_tokens: 2 } } },
        {
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "private" },
        },
        {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "answer" },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 5 },
        },
        { type: "message_stop" },
      ],
    },
    {
      protocol: "gemini" as const,
      frames: [
        {
          candidates: [
            {
              content: {
                parts: [{ text: "private", thought: true }, { text: "answer" }],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 2,
            candidatesTokenCount: 1,
            thoughtsTokenCount: 4,
          },
        },
      ],
    },
  ];
  for (const c of cases) {
    const response = new Response(
      c.frames.map((f) => "data: " + JSON.stringify(f) + "\n\n").join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
    const output = [];
    for await (const e of upstreamEvents(c.protocol, response.body!))
      output.push(e);
    expect(
      output
        .filter((e) => e.type === "text")
        .map((e) => e.text)
        .join(""),
    ).toBe("answer");
    expect(output.find((e) => e.type === "usage")).toMatchObject({
      usage: { output: 5 },
    });
  }
});
it("times out a decision without suppressing the original request cancellation", async () => {
  const host: any = {
    call: (_: string, _i: any, s: AbortSignal) =>
      new Promise((_, reject) => {
        s.addEventListener("abort", () => reject(s.reason), { once: true });
      }),
  };
  const keepAlive = setTimeout(() => {}, 500);
  try {
    await expect(
      decide(
        host,
        { kind: "jev", baseUrl: "http://localhost", timeoutMs: 50 },
        request(),
        signal(),
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  } finally {
    clearTimeout(keepAlive);
  }
});
it("maps thinking settings across protocols and rejects lossy conversions", () => {
  for (const [p, b] of [
    ["openai-chat", { reasoning_effort: "high" }],
    ["openai-responses", { reasoning: { effort: "high" } }],
    ["anthropic", { output_config: { effort: "high" } }],
    [
      "gemini",
      { generationConfig: { thinkingConfig: { thinkingLevel: "HIGH" } } },
    ],
  ] as const) {
    expect(decodeReasoning(p, b)).toEqual({ effort: "high" });
    expect(encodeReasoning(p, { effort: "high" })).toBeDefined();
  }
  expect(encodeReasoning("gemini", { effort: "max" })).toEqual({
    thinkingConfig: { thinkingLevel: "HIGH" },
  });
  expect(() =>
    encodeReasoning("openai-chat", { budgetTokens: 1024 }),
  ).toThrow();
  expect(
    decodeResult(
      "anthropic",
      {
        content: [
          { type: "thinking", thinking: "private" },
          { type: "text", text: "answer" },
        ],
        stop_reason: "end_turn",
      },
      "m",
    ).text,
  ).toBe("answer");
});
async function* source(events: AIEvent[]) {
  yield* events;
}
it("paces actual tokenizer counts, preserves Unicode and tool payloads and accounts hidden usage", async () => {
  const encoding = getEncoding("o200k_base");
  const count = (s: string) => encoding.encode(s, [], []).length;
  let time = 0;
  const pacer = new TokenPacer(
    () => 10,
    () => time,
    async (ms) => {
      time += ms;
    },
  );
  const events: AIEvent[] = [
    { type: "text", text: "Hello 世界🙂" },
    {
      type: "tool",
      index: 0,
      id: "t",
      name: "get_weather",
      arguments: '{"city":"北京"}',
    },
    { type: "usage", usage: { input: 1, output: 100 } },
    { type: "finish", reason: "tool_calls" },
  ];
  const output: AIEvent[] = [];
  for await (const e of paceEvents(
    source(events),
    count,
    (cost) => pacer.take(cost, signal()),
    signal(),
  ))
    output.push(e);
  expect(
    output
      .filter((e) => e.type === "text")
      .map((e) => e.text)
      .join(""),
  ).toBe("Hello 世界🙂");
  expect(
    output
      .filter((e) => e.type === "tool")
      .map((e) => e.arguments ?? "")
      .join(""),
  ).toBe('{"city":"北京"}');
  expect(
    output.filter((e) => e.type === "tool" && e.name).map((e) => e.name),
  ).toEqual(["get_weather"]);
  expect(time).toBe(10000);
  expect(count("Hello 世界🙂")).not.toBe(Array.from("Hello 世界🙂").length);
});
it.each(["anthropic", "openai-responses"] as const)(
  "keeps complete tool names in paced %s start frames",
  async (protocol) => {
    const events: AIEvent[] = [
      {
        type: "tool",
        index: 0,
        id: "t",
        name: "get_weather",
        arguments: '{"a":1}',
      },
      { type: "finish", reason: "tool_calls" },
    ];
    const paced = paceEvents(
      source(events),
      (s) => s.length,
      async () => {},
      signal(),
    );
    const wire = await new Response(
      encodeStream(protocol, paced, "m", signal()),
    ).text();
    const frames = wire
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));
    expect(
      protocol === "anthropic"
        ? frames.find(
            (f) =>
              f.type === "content_block_start" &&
              f.content_block.type === "tool_use",
          ).content_block.name
        : frames.find(
            (f) =>
              f.type === "response.output_item.added" &&
              f.item.type === "function_call",
          ).item.name,
    ).toBe("get_weather");
  },
);
it("does not accumulate idle bursts and gives each request an independent clock", async () => {
  let time = 0;
  const p = new TokenPacer(
    () => 2,
    () => time,
    async (ms) => {
      time += ms;
    },
  );
  await p.take(1, signal());
  expect(time).toBe(500);
  time = 10000;
  await p.take(1, signal());
  expect(time).toBe(10500);
  const starts: number[] = [];
  await Promise.all(
    [1, 2].map(async () => {
      let t = 0;
      const pacer = new TokenPacer(
        () => 2,
        () => t,
        async (ms) => {
          t += ms;
        },
      );
      await pacer.take(2, signal());
      starts.push(t);
    }),
  );
  expect(starts).toEqual([1000, 1000]);
});
it("cancels waiting token jobs, closes upstream iterators and rejects tracking overflow", async () => {
  const c = new AbortController();
  const p = new TokenPacer(() => 1);
  const waiting = p.take(100, c.signal);
  c.abort();
  await expect(waiting).rejects.toBeDefined();
  let closed = false;
  async function* upstream() {
    try {
      yield { type: "text", text: "abcdef" } as const;
    } finally {
      closed = true;
    }
  }
  const events = paceEvents(
    upstream(),
    (s) => s.length,
    async () => {},
    signal(),
  );
  await events.next();
  await events.return(undefined);
  expect(closed).toBe(true);
  const overflow = paceEvents(
    source([{ type: "text", text: "abcdef" }]),
    (s) => s.length,
    async () => {},
    signal(),
    3,
  );
  await expect(
    (async () => {
      for await (const _ of overflow) {
      }
    })(),
  ).rejects.toMatchObject({ code: "token_tracking_limit" });
});
