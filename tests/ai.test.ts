import { it, expect } from "vitest";
import { decode, encodeRequest, collect } from "../lib/ai/protocols.js";
import { parseSSE } from "../lib/ai/protocols.js";
import { upstreamEvents, encodeStream } from "../lib/ai/streams.js";
const bytes = (text: string) => {
  const data = new TextEncoder().encode(text);
  let n = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (n < data.length) c.enqueue(data.slice(n, (n += 1)));
      else c.close();
    },
  });
};
it("parses arbitrary UTF-8 and CRLF SSE boundaries", async () => {
  const out = [];
  for await (const frame of parseSSE(
    bytes(
      ': ping\r\ndata: {"text":"你好"}\r\n\r\nevent: done\r\ndata: 1\r\n\r\n',
    ),
  ))
    out.push(frame);
  expect(out).toEqual([
    { event: "message", data: '{"text":"你好"}' },
    { event: "done", data: "1" },
  ]);
});
it("rejects unsupported features instead of dropping them", () => {
  expect(() =>
    decode("openai-chat", {
      model: "m",
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "x" } }],
        },
      ],
    }),
  ).toThrow("Invalid image URL");
  expect(() =>
    decode("openai-responses", {
      model: "m",
      input: "hi",
      previous_response_id: "x",
    }),
  ).toThrow("Unsupported");
});
it("converts tool results independently from the entry protocol", () => {
  const request = decode("openai-chat", {
    model: "m",
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "weather", arguments: '{"city":"合肥"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: '{"temperature":20}' },
    ],
  });
  expect(
    encodeRequest("anthropic", request).messages[0].content[0],
  ).toMatchObject({ type: "tool_use", input: { city: "合肥" } });
  expect(
    encodeRequest("gemini", request).contents[1].parts[0].functionResponse,
  ).toMatchObject({ name: "weather", response: { temperature: 20 } });
});
it("collects fragmented tool arguments and final usage", async () => {
  const raw =
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"weather","arguments":"{\\"city\\":"}}]}}]}\n\ndata: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Hefei\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":4}}\n\ndata: [DONE]\n\n';
  const result = await collect(upstreamEvents("openai-chat", bytes(raw)), "m");
  expect(result.calls[0]).toEqual({
    id: "c1",
    name: "weather",
    arguments: '{"city":"Hefei"}',
  });
  expect(result.usage).toEqual({ input: 7, output: 4 });
});
it("reports a truncated upstream stream", async () => {
  await expect(
    collect(
      upstreamEvents(
        "openai-chat",
        bytes(
          'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n',
        ),
      ),
      "m",
    ),
  ).rejects.toThrow("before completion");
});
it("emits complete Responses tool and terminal events with monotonic sequence numbers", async () => {
  async function* events() {
    yield { type: "text" as const, text: "你好" };
    yield {
      type: "tool" as const,
      index: 0,
      id: "c1",
      name: "weather",
      arguments: "{}",
    };
    yield { type: "usage" as const, usage: { input: 2, output: 3 } };
    yield { type: "finish" as const, reason: "tool_calls" as const };
  }
  const output = await new Response(
    encodeStream(
      "openai-responses",
      events(),
      "m",
      new AbortController().signal,
    ),
  ).text();
  const frames = [];
  for await (const frame of parseSSE(bytes(output)))
    frames.push(JSON.parse(frame.data));
  expect(frames.map((f) => f.sequence_number)).toEqual(frames.map((_, i) => i));
  expect(
    frames.some((f) => f.type === "response.function_call_arguments.done"),
  ).toBe(true);
  expect(frames.at(-1).response.usage).toMatchObject({
    input_tokens: 2,
    output_tokens: 3,
  });
  expect(frames.at(-1).response.output[0].content[0].text).toBe("你好");
});

it("rejects non-object request bodies", () => {
  for (const protocol of [
    "openai-chat",
    "openai-responses",
    "anthropic",
    "gemini",
  ] as const)
    expect(() => decode(protocol, null)).toThrow();
});
