import { expect, it } from "vitest";
import {
  priceUsage,
  reserveCost,
  routePricing,
} from "../lib/commerce/pricing.js";
import { decodeUsage, encodeUsage } from "../lib/ai/usage.js";
import { upstreamEvents, encodeStream } from "../lib/ai/streams.js";
import { decode, decodeResult, encodeResult } from "../lib/ai/protocols.js";
import type { Protocol, Usage } from "@pluhub/contracts/ai";

it("prices cache subsets once, separates one-hour writes and multiplies exact decimals once", () => {
  const receipt = priceUsage(
    {
      input: 1000,
      output: 100,
      cacheRead: 600,
      cacheWrite: 200,
      cacheWrite1h: 50,
      reasoning: 40,
    },
    {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
      cacheWrite1h: 6,
      multiplier: 0.5,
    },
  );
  // 600 + 1500 + 180 + 562.5 + 300 = 3142.5, times 0.5.
  expect(receipt.amount).toBe(1572);
  expect(receipt.originalAmount).toBe(3143);
  expect(receipt.lines.map((line) => line.quantity)).toEqual([
    200, 100, 600, 150, 50,
  ]);
  expect(
    priceUsage(
      { input: 1, output: 1 },
      { input: 0.1, output: 0.2, multiplier: 10 },
    ).amount,
  ).toBe(3);
  expect(
    priceUsage(
      { input: 1, output: 0 },
      { input: 1e-7, output: 0, multiplier: 10 },
    ).amount,
  ).toBe(1);
  expect(
    priceUsage(
      { input: 1000000, output: 0 },
      { input: 0.1, output: 0, multiplier: 0 },
    ).amount,
  ).toBe(0);
});
it("uses whole-request context tiers with strict boundaries and reserves the worst cache/context rate", () => {
  const pricing = {
    input: 1,
    output: 2,
    cacheRead: 0.1,
    tiers: [{ above: 100, input: 2, output: 3, cacheWrite: 5 }],
  };
  expect(priceUsage({ input: 100, output: 1 }, pricing).amount).toBe(102);
  expect(priceUsage({ input: 101, output: 1 }, pricing)).toMatchObject({
    amount: 205,
    tierAbove: 100,
  });
  expect(reserveCost(101, 10, pricing)).toBe(535);
  expect(() =>
    priceUsage(
      { input: 1, output: 0 },
      { ...pricing, tiers: [pricing.tiers[0]!, pricing.tiers[0]!] },
    ),
  ).toThrow("strictly increasing");
});
it("supports per-request prices without token prices and preserves original route prices", () => {
  const route = {
    upstream: "x",
    model: "m",
    inputPrice: 3,
    outputPrice: 15,
    pricing: { cacheRead: 0.3 },
  };
  const before = structuredClone(route);
  expect(routePricing(route, { consumptionMultiplier: 0.4 })).toMatchObject({
    input: 3,
    output: 15,
    cacheRead: 0.3,
    multiplier: 0.4,
  });
  expect(route).toEqual(before);
  const pricing = routePricing({
    upstream: "x",
    model: "m",
    pricing: { mode: "request", request: 0.001 },
  })!;
  expect(
    priceUsage({ input: 5000, output: 6000 }, { ...pricing, multiplier: 0.5 })
      .amount,
  ).toBe(500);
  expect(reserveCost(999999, 999999, pricing)).toBe(1000);
});
it("rejects invalid prices, overlapping cache usage, unsafe totals and overflows", () => {
  for (const usage of [
    { input: -1, output: 0 },
    { input: 10, output: 0, cacheRead: 8, cacheWrite: 3 },
    { input: 10, output: 0, cacheWrite: 2, cacheWrite1h: 3 },
    { input: 10, output: 2, reasoning: 3 },
  ])
    expect(() => priceUsage(usage, { input: 1, output: 1 })).toThrow();
  for (const rate of [-1, Infinity, NaN, 1000001])
    expect(() =>
      priceUsage({ input: 1, output: 1 }, { input: rate, output: 1 }),
    ).toThrow();
  expect(() =>
    priceUsage(
      { input: Number.MAX_SAFE_INTEGER, output: 0 },
      { input: 1e6, output: 1 },
    ),
  ).toThrow("integer range");
});
it("preserves provider cache and reasoning details in stream and non-stream usage", () => {
  const pairs: [Protocol, any, Usage][] = [
    [
      "openai-chat",
      {
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 6 },
        completion_tokens_details: { reasoning_tokens: 3 },
      },
      { input: 10, output: 5, cacheRead: 6, reasoning: 3 },
    ],
    [
      "openai-responses",
      {
        input_tokens: 10,
        output_tokens: 5,
        input_tokens_details: { cached_tokens: 6, cache_write_tokens: 2 },
        output_tokens_details: { reasoning_tokens: 3 },
      },
      { input: 10, output: 5, cacheRead: 6, cacheWrite: 2, reasoning: 3 },
    ],
    [
      "anthropic",
      {
        input_tokens: 3,
        output_tokens: 5,
        cache_read_input_tokens: 6,
        cache_creation_input_tokens: 4,
        cache_creation: {
          ephemeral_5m_input_tokens: 1,
          ephemeral_1h_input_tokens: 3,
        },
      },
      { input: 13, output: 5, cacheRead: 6, cacheWrite: 4, cacheWrite1h: 3 },
    ],
    [
      "gemini",
      {
        promptTokenCount: 10,
        candidatesTokenCount: 2,
        thoughtsTokenCount: 3,
        cachedContentTokenCount: 6,
      },
      { input: 10, output: 5, cacheRead: 6, reasoning: 3 },
    ],
  ];
  for (const [protocol, raw, normalized] of pairs) {
    expect(decodeUsage(protocol, raw)).toEqual(normalized);
    expect(decodeUsage(protocol, encodeUsage(protocol, normalized))).toEqual(
      normalized,
    );
  }
  expect(() =>
    decodeUsage("anthropic", {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: "5",
    }),
  ).toThrow();
});
const body = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (offset === bytes.length) c.close();
      else c.enqueue(bytes.slice(offset, ++offset));
    },
  });
};
it("uses Gemini's terminal usage snapshot and preserves empty-text signature parts", async () => {
  const candidate = (parts: any[], finishReason?: string) => ({
    content: { role: "model", parts },
    ...(finishReason ? { finishReason } : {}),
  });
  const frames = [
    {
      candidates: [candidate([{ text: "OK" }])],
      usageMetadata: {
        promptTokenCount: 5,
        candidatesTokenCount: 1,
        thoughtsTokenCount: 128,
      },
    },
    {
      candidates: [
        candidate([{ text: "", thoughtSignature: "signature" }], "STOP"),
      ],
      usageMetadata: {
        promptTokenCount: 5,
        candidatesTokenCount: 1,
        thoughtsTokenCount: 64,
      },
    },
  ];
  const events = [];
  for await (const event of upstreamEvents(
    "gemini",
    body(
      frames.map((frame) => "data: " + JSON.stringify(frame) + "\n\n").join(""),
    ),
  ))
    events.push(event);
  expect(events.filter((event) => event.type === "usage")).toEqual([
    { type: "usage", usage: { input: 5, output: 65, reasoning: 64 } },
  ]);
  expect(events).toContainEqual({
    type: "reasoning",
    index: 0,
    source: "gemini",
    text: "",
    signature: "signature",
  });
  expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
  const result = decodeResult(
    "gemini",
    {
      candidates: [
        candidate(
          [{ text: "OK" }, { text: "", thoughtSignature: "signature" }],
          "STOP",
        ),
      ],
      usageMetadata: frames[1]!.usageMetadata,
    },
    "demo",
  );
  expect(result.text).toBe("OK");
  expect(result.reasoning).toEqual([
    { source: "gemini", text: "", signature: "signature" },
  ]);
  const request = decode(
    "gemini",
    {
      contents: [
        candidate([{ text: "OK" }, { text: "", thoughtSignature: "signature" }])
          .content,
      ],
    },
    "demo",
  );
  expect(
    request.messages.flatMap((message) => message.reasoning ?? []),
  ).toEqual(result.reasoning!);
  expect(
    priceUsage(result.usage, { input: 0.3, output: 2.5, multiplier: 0.2 })
      .amount,
  ).toBe(33);
  expect(
    decodeResult("gemini", encodeResult("gemini", result), "demo").reasoning,
  ).toEqual(result.reasoning!);
});

it("round trips usage through every wire protocol with arbitrary chunk splitting", async () => {
  for (const protocol of [
    "openai-chat",
    "openai-responses",
    "anthropic",
    "gemini",
  ] as Protocol[]) {
    const usage: Usage =
      protocol === "anthropic"
        ? { input: 14, output: 5, cacheRead: 6, cacheWrite: 5, cacheWrite1h: 2 }
        : { input: 14, output: 5, cacheRead: 6, reasoning: 2 };
    async function* events() {
      yield { type: "text" as const, text: "你好" };
      yield { type: "usage" as const, usage };
      yield { type: "finish" as const, reason: "stop" as const };
    }
    const response = new Response(
      encodeStream(protocol, events(), "m", new AbortController().signal),
    );
    const decoded = [];
    for await (const event of upstreamEvents(
      protocol,
      body(await response.text()),
    ))
      decoded.push(event);
    expect(decoded.find((event) => event.type === "usage")).toEqual({
      type: "usage",
      usage,
    });
  }
});
