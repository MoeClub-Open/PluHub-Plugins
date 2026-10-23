import { expect, it } from "vitest";
import {
  decode,
  encodeRequest,
  decodeResult,
  encodeResult,
  collect,
  resultEvents,
} from "../lib/ai/protocols.js";
import { upstreamEvents, encodeStream } from "../lib/ai/streams.js";
import { validateWebSearchTarget } from "../lib/ai/web-search.js";
import {
  observeEvents,
  beginObservation,
  observation,
} from "../lib/ai/telemetry.js";
import { priceUsage, reserveCost } from "../lib/commerce/pricing.js";

const call = {
  id: "ws1",
  type: "web_search_call",
  status: "completed",
  action: { type: "search", query: "weather" },
};
const citation = {
  type: "url_citation",
  url: "https://example.com/source",
  title: "Source",
  start_index: 0,
  end_index: 2,
};
const output = [
  call,
  {
    id: "msg1",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "晴天", annotations: [citation] }],
  },
];
const completed = {
  id: "r1",
  status: "completed",
  output,
  usage: { input_tokens: 20, output_tokens: 4 },
};
function body(frames: any[]) {
  const bytes = new TextEncoder().encode(
    frames.map((data) => "data: " + JSON.stringify(data) + "\r\n\r\n").join(""),
  );
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) controller.close();
      else controller.enqueue(bytes.slice(offset, ++offset));
    },
  });
}
it("separates hosted searches from function tools and retains controls and choice", () => {
  const request = decode("openai-responses", {
    model: "m",
    input: "weather",
    tools: [
      { type: "web_search", filters: { allowed_domains: ["example.com"] } },
      { type: "function", name: "weather", parameters: { type: "object" } },
    ],
    tool_choice: { type: "web_search" },
    include: ["web_search_call.action.sources"],
  });
  expect(request.tools.map((t) => t.name)).toEqual(["weather"]);
  const encoded = encodeRequest("openai-responses", request);
  expect(encoded.tools).toHaveLength(2);
  expect(encoded.tools).toContainEqual({
    type: "web_search",
    filters: { allowed_domains: ["example.com"] },
  });
  expect(encoded.tool_choice).toEqual({ type: "web_search" });
  expect(encoded.include).toContain("web_search_call.action.sources");
  expect(() => validateWebSearchTarget(request, "gemini")).toThrow();
  expect(() => validateWebSearchTarget(request, "openai-chat")).toThrow();
  expect(() => validateWebSearchTarget(request, "codex")).not.toThrow();
});
it("round trips search results and citations through Chat and Responses history", () => {
  const result = decodeResult("openai-responses", completed, "alias");
  expect(result.citations).toEqual([
    { url: citation.url, title: "Source", startIndex: 0, endIndex: 2 },
  ]);
  const chat = encodeResult("openai-chat", result);
  const request = decode("openai-chat", {
    model: "alias",
    messages: [
      { role: "user", content: "weather" },
      chat.choices[0].message,
      { role: "user", content: "more" },
    ],
  });
  const encoded = encodeRequest("openai-responses", request);
  expect(encoded.input).toContainEqual(
    expect.objectContaining({ type: "web_search_call", id: "ws1" }),
  );
  expect(
    encoded.input.find((item: any) => item.role === "assistant").content[0]
      .annotations,
  ).toEqual([citation]);
});
it("deduplicates split SSE search snapshots, final text, citations and billable searches", async () => {
  const frames = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "ws1", type: "web_search_call", status: "in_progress" },
    },
    {
      type: "response.web_search_call.searching",
      output_index: 0,
      item_id: "ws1",
    },
    { type: "response.output_item.done", output_index: 0, item: call },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { id: "msg1", type: "message", role: "assistant", content: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 1,
      content_index: 0,
      item_id: "msg1",
      delta: "晴天",
    },
    {
      type: "response.output_text.annotation.added",
      output_index: 1,
      item_id: "msg1",
      content_index: 0,
      annotation_index: 0,
      annotation: citation,
    },
    { type: "response.output_item.done", output_index: 1, item: output[1] },
    { type: "response.completed", response: completed },
  ];
  const ctx = { state: new Map() } as any;
  beginObservation(ctx, "openai-responses");
  const result = await collect(
    observeEvents(upstreamEvents("openai-responses", body(frames)), ctx),
    "alias",
  );
  expect(result.text).toBe("晴天");
  expect(result.searchCalls).toHaveLength(1);
  expect(result.citations).toHaveLength(1);
  expect(observation(ctx)).toMatchObject({
    finished: true,
    usage: { input: 20, output: 4, webSearch: 1 },
    routing: { webSearchCalls: 1 },
  });
  const rendered = await new Response(
    encodeStream(
      "openai-responses",
      resultEvents(result),
      "alias",
      new AbortController().signal,
    ),
  ).text();
  expect(rendered).toContain("response.web_search_call.completed");
  expect(rendered).toContain("response.output_text.annotation.added");
});
it("charges hosted tool calls once with the channel multiplier, including fixed and expression pricing", () => {
  for (const pricing of [
    { input: 1, output: 2 },
    { input: 0, output: 0, mode: "request" as const, request: 0.001 },
    {
      input: 0,
      output: 0,
      mode: "expression" as const,
      expression: 'tier("base", fixed(0.001))',
      context: { at: Date.now(), params: {}, headers: {} },
    },
  ]) {
    const price = { ...pricing, webSearch: 0.01, multiplier: 0.2 };
    const receipt = priceUsage({ input: 100, output: 10, webSearch: 2 }, price);
    const base = priceUsage({ input: 100, output: 10 }, price);
    expect(receipt.amount - base.amount).toBe(4000);
    expect(receipt.lines.find((line) => line.kind === "webSearch")).toEqual({
      kind: "webSearch",
      quantity: 2,
      rate: 0.01,
    });
    expect(reserveCost(100, 10, price, 3)).toBeGreaterThanOrEqual(
      receipt.amount,
    );
  }
});
it("rejects undeclared choices, duplicate hosted tools and unsafe citation links", () => {
  for (const tools of [[], [{ type: "web_search" }, { type: "web_search" }]])
    expect(() =>
      decode("openai-responses", {
        model: "m",
        input: "test",
        tools,
        tool_choice: { type: "web_search" },
      }),
    ).toThrow();
  expect(() =>
    decodeResult(
      "openai-responses",
      {
        ...completed,
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "bad",
                annotations: [{ ...citation, url: "javascript:alert(1)" }],
              },
            ],
          },
        ],
      },
      "m",
    ),
  ).toThrow();
});
it("retains the Responses hosted-tool call bound and rejects conversions that lose it", () => {
  const request = decode("openai-responses", {
    model: "m",
    input: "search",
    tools: [{ type: "web_search" }],
    max_tool_calls: 1,
  });
  expect(request.webSearch?.maxCalls).toBe(1);
  expect(encodeRequest("openai-responses", request).max_tool_calls).toBe(1);
  expect(() => validateWebSearchTarget(request, "openai-chat")).toThrow();
  expect(() =>
    decode("openai-responses", {
      model: "m",
      input: "search",
      tools: [{ type: "web_search" }],
      max_tool_calls: -1,
    }),
  ).toThrow();
});
