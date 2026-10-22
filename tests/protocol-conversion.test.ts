import { describe, it, expect, vi } from "vitest";
import type {
  AIEvent,
  AIRequest,
  AIResult,
  Protocol,
} from "@pluhub/contracts/ai";
import { HostError } from "@pluhub/sdk";
import {
  decode,
  encodeRequest,
  decodeResult,
  encodeResult,
  collect,
  resultEvents,
  protocolError,
} from "../lib/ai/protocols.js";
import { upstreamEvents, encodeStream } from "../lib/ai/streams.js";
import { parseSSE } from "../lib/ai/sse.js";
import { observeEvents } from "../lib/ai/telemetry.js";
import { paceEvents } from "../plugins/token-speed/pacing.js";

const protocols: Protocol[] = [
  "openai-chat",
  "openai-responses",
  "anthropic",
  "gemini",
];
const signal = () => new AbortController().signal;
const sse = (...data: any[]) =>
  data.map((d) => "data: " + JSON.stringify(d) + "\n\n").join("");
function bytes(raw: string, step = 1) {
  const data = new TextEncoder().encode(raw);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (offset >= data.length) c.close();
      else {
        c.enqueue(data.slice(offset, offset + step));
        offset += step;
      }
    },
  });
}
async function list<T>(source: AsyncIterable<T>) {
  const out: T[] = [];
  for await (const e of source) out.push(e);
  return out;
}
function events(data: AIEvent[]): AsyncIterable<AIEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* data;
    },
  };
}
const request = (): AIRequest => ({
  model: "m",
  stream: false,
  tools: [],
  messages: [{ role: "user", text: "你好" }],
});
const result = (): AIResult => ({
  id: "r1",
  model: "m",
  text: "你好",
  calls: [{ id: "c1", name: "weather", arguments: '{"city":"合肥"}' }],
  reason: "tool_calls",
  usage: { input: 18, output: 8, cacheRead: 5, cacheWrite: 3, reasoning: 2 },
});
const imageURL = "data:image/png;base64,aGk=";

describe("request conversion matrix", () => {
  for (const from of protocols)
    for (const to of protocols)
      it(`${from} -> ${to}: images, tools and ordered history`, () => {
        const input = {
          ...request(),
          maxTokens: 64,
          topP: 0.8,
          tools: [
            { name: "weather", strict: true, parameters: { type: "object" } },
          ],
          toolChoice: { name: "weather" },
          messages: [
            { role: "system" as const, text: "Be concise" },
            {
              role: "user" as const,
              text: "beforeafter",
              content: [
                { type: "text" as const, text: "before" },
                { type: "image" as const, url: imageURL },
                { type: "text" as const, text: "after" },
              ],
            },
            {
              role: "assistant" as const,
              text: "",
              calls: [{ id: "c1", name: "weather", arguments: "{}" }],
            },
            {
              role: "tool" as const,
              text: '{"result":"first"}',
              callId: "c1",
              toolName: "weather",
            },
            { role: "user" as const, text: "last" },
          ],
        } satisfies AIRequest;
        const source = encodeRequest(from, input);
        const normalized = decode(from, source, "m");
        const wire = encodeRequest(to, normalized);
        const roundtrip = decode(to, wire, "m");
        const contents = roundtrip.messages.find((m) => m.content)?.content;
        expect(contents?.map((p) => p.type)).toEqual(["text", "image", "text"]);
        expect(contents?.[1]).toMatchObject({ url: imageURL });
        expect(
          roundtrip.messages.filter((m) => m.role === "tool")[0],
        ).toMatchObject({ callId: "c1", text: '{"result":"first"}' });
        expect(roundtrip.messages.at(-1)?.text).toBe("last");
        expect(roundtrip.tools[0]).toMatchObject({
          name: "weather",
          parameters: { type: "object" },
        });
        // ANY enforces Gemini schema matching; tool names and schema survive even without per-tool strict.
        if (from !== "gemini" && to !== "gemini")
          expect(roundtrip.tools[0]!.strict).toBe(true);
        expect(roundtrip.topP).toBe(0.8);
        expect(roundtrip.toolChoice).toEqual({ name: "weather" });
      });
  it("preserves developer role and stateless encrypted reasoning requests", () => {
    const r = decode("openai-responses", {
      model: "m",
      input: [{ role: "developer", content: "Policy" }],
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "high", summary: "auto" },
    });
    expect(
      encodeRequest("openai-chat", { ...r, reasoning: undefined }).messages[0]
        .role,
    ).toBe("developer");
    expect(encodeRequest("openai-responses", r)).toMatchObject({
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "high", summary: "auto" },
    });
    expect(() => encodeRequest("anthropic", r)).toThrow(
      "Encrypted reasoning output",
    );
  });
  it("maps JSON schema and parallel settings without losing their constraints", () => {
    const r = decode("openai-chat", {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          schema: { type: "object", additionalProperties: false },
          strict: true,
        },
      },
      parallel_tool_calls: false,
    });
    expect(encodeRequest("openai-responses", r)).toMatchObject({
      parallel_tool_calls: false,
      text: { format: { type: "json_schema", name: "answer", strict: true } },
    });
    expect(encodeRequest("anthropic", r)).toMatchObject({
      tool_choice: { disable_parallel_tool_use: true },
      output_config: { format: { type: "json_schema" } },
    });
    expect(() => encodeRequest("gemini", r)).toThrow("parallel");
    expect(
      encodeRequest("gemini", { ...r, parallelToolCalls: undefined })
        .generationConfig,
    ).toMatchObject({
      responseMimeType: "application/json",
      responseJsonSchema: { type: "object" },
    });
    expect(() =>
      encodeRequest("anthropic", {
        ...r,
        responseFormat: {
          type: "json_schema",
          name: "x",
          schema: {},
          strict: false,
        },
      }),
    ).toThrow("relaxed");
  });
  it("rejects ambiguous same-name Gemini results and accepts explicit IDs", () => {
    const body = {
      contents: [
        {
          role: "model",
          parts: ["a", "b"].map((id) => ({
            functionCall: { id, name: "weather", args: {} },
          })),
        },
        {
          role: "user",
          parts: [{ functionResponse: { name: "weather", response: {} } }],
        },
      ],
    };
    expect(() => decode("gemini", body, "m")).toThrow("Ambiguous");
    body.contents[1]!.parts = [
      { functionResponse: { id: "b", name: "weather", response: {} } },
    ] as any;
    expect(decode("gemini", body, "m").messages.at(-1)).toMatchObject({
      role: "tool",
      callId: "b",
    });
  });
  it("preserves Responses call_id instead of its output item ID", () => {
    expect(
      decodeResult(
        "openai-responses",
        {
          status: "completed",
          output: [
            {
              type: "function_call",
              id: "fc_item",
              call_id: "call_actual",
              name: "weather",
              arguments: "{}",
            },
          ],
        },
        "m",
      ).calls[0]!.id,
    ).toBe("call_actual");
  });
  it.each([
    ["openai-chat", { messages: [null] }],
    [
      "openai-chat",
      { messages: [{ role: "user", content: "hi" }], tool_choice: 12 },
    ],
    [
      "openai-chat",
      {
        messages: [
          { role: "user", content: [{ type: "input_audio", input_audio: {} }] },
        ],
      },
    ],
    ["openai-responses", { input: "hi", store: "false" }],
    ["openai-responses", { input: [{ type: "reasoning", summary: {} }] }],
    [
      "anthropic",
      {
        messages: [
          {
            role: "user",
            content: [{ type: "thinking", thinking: "wrong role" }],
          },
        ],
      },
    ],
    ["gemini", { contents: [{ role: "user", parts: [null] }] }],
  ] as [Protocol, any][])(
    "rejects malformed or unsupported %s input",
    (p, body) => {
      expect(() => decode(p, { model: "m", ...body }, "m")).toThrow(HostError);
    },
  );
  it("rejects unrepresentable stop, image detail and thinking budgets", () => {
    expect(() =>
      encodeRequest("openai-responses", { ...request(), stop: ["END"] }),
    ).toThrow("stop");
    expect(() =>
      encodeRequest("anthropic", {
        ...request(),
        maxTokens: 1024,
        reasoning: { budgetTokens: 1024 },
      }),
    ).toThrow("budget");
    const r = {
      ...request(),
      messages: [
        {
          role: "user" as const,
          text: "",
          content: [
            { type: "image" as const, url: imageURL, detail: "high" as const },
          ],
        },
      ],
    };
    expect(() => encodeRequest("anthropic", r)).toThrow("image detail");
  });
});

describe("reasoning provenance and structured results", () => {
  for (const target of protocols)
    it(`preserves Anthropic signatures through ${target} and back`, async () => {
      const r = {
        ...result(),
        calls: [],
        reason: "stop" as const,
        reasoning: [
          {
            source: "anthropic" as const,
            text: "思考",
            signature: "opaque-signature",
          },
        ],
      };
      const serialized = encodeResult(target, r);
      const decoded = decodeResult(target, serialized, "m");
      expect(decoded.reasoning).toEqual(r.reasoning);
      const history: AIRequest = {
        ...request(),
        messages: [
          {
            role: "assistant",
            text: decoded.text,
            reasoning: decoded.reasoning,
          },
        ],
      };
      expect(
        encodeRequest("anthropic", history).messages[0].content[0],
      ).toMatchObject({
        type: "thinking",
        thinking: "思考",
        signature: "opaque-signature",
      });
      if (target !== "anthropic")
        expect(() => encodeRequest(target, history)).toThrow("belongs to");
      const output = await new Response(
        encodeStream(target, resultEvents(r), "m", signal()),
      ).text();
      const roundtrip = await collect(
        upstreamEvents(target, bytes(output)),
        "m",
      );
      expect(roundtrip.reasoning?.[0]).toMatchObject(r.reasoning[0]!);
      expect(roundtrip.text).toBe(r.text);
    });
  it("preserves redacted/encrypted blocks and Gemini tool signatures", () => {
    for (const block of [
      { source: "anthropic" as const, text: "", redacted: "redacted" },
      {
        source: "openai-responses" as const,
        text: "summary",
        encrypted: "cipher",
        id: "rs_1",
      },
    ]) {
      for (const p of protocols)
        expect(
          decodeResult(
            p,
            encodeResult(p, { ...result(), reasoning: [block] }),
            "m",
          ).reasoning?.[0],
        ).toEqual(block);
    }
    const r = {
      ...result(),
      calls: [{ ...result().calls[0]!, thoughtSignature: "gemini-sig" }],
    };
    for (const p of protocols.filter((p) => p !== "anthropic"))
      expect(decodeResult(p, encodeResult(p, r), "m").calls[0]).toMatchObject(
        r.calls[0]!,
      );
    expect(() => encodeResult("anthropic", r)).toThrow("signature");
  });
  it("preserves Gemini tool signatures through Responses stream final items", async () => {
    const r = {
      ...result(),
      calls: [{ ...result().calls[0]!, thoughtSignature: "gemini-sig" }],
    };
    const output = await new Response(
      encodeStream("openai-responses", resultEvents(r), "m", signal()),
    ).text();
    expect(
      (await collect(upstreamEvents("openai-responses", bytes(output)), "m"))
        .calls,
    ).toEqual(r.calls);
  });
  it("maps safety, refusals, stop sequences and usage totals", () => {
    expect(
      decodeResult(
        "gemini",
        {
          candidates: [{ finishReason: "SAFETY", content: { parts: [] } }],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 2,
            thoughtsTokenCount: 4,
          },
        },
        "m",
      ),
    ).toMatchObject({
      reason: "content_filter",
      usage: { input: 10, output: 6, reasoning: 4 },
    });
    expect(
      decodeResult(
        "openai-chat",
        {
          choices: [
            {
              message: { content: null, refusal: "denied" },
              finish_reason: "content_filter",
            },
          ],
        },
        "m",
      ),
    ).toMatchObject({ refusal: "denied", reason: "content_filter" });
    expect(
      encodeResult("anthropic", {
        ...result(),
        reason: "stop",
        stopSequence: "END",
      }),
    ).toMatchObject({ stop_reason: "stop_sequence", stop_sequence: "END" });
    expect(
      decodeResult(
        "anthropic",
        {
          content: [],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 3,
          },
        },
        "m",
      ).usage,
    ).toEqual({ input: 18, output: 2, cacheRead: 5, cacheWrite: 3 });
  });
});

describe("stream state machines", () => {
  it("deduplicates Responses snapshots, retains final encrypted reasoning and call IDs", async () => {
    const tool = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "weather",
      arguments: "{}",
    };
    const thinking = {
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: "why" }],
    };
    const output = sse(
      { type: "response.output_item.added", item: { ...tool, arguments: "" } },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        delta: "{",
      },
      {
        type: "response.function_call_arguments.done",
        item_id: "fc_1",
        arguments: "{}",
      },
      { type: "response.output_item.done", item: tool },
      {
        type: "response.output_text.delta",
        item_id: "msg_1",
        content_index: 0,
        delta: "Hi",
      },
      {
        type: "response.output_text.done",
        item_id: "msg_1",
        content_index: 0,
        text: "Hi!",
      },
      { type: "response.output_item.done", item: thinking },
      {
        type: "response.completed",
        response: {
          output: [
            tool,
            {
              type: "message",
              id: "msg_1",
              content: [{ type: "output_text", text: "Hi!" }],
            },
            { ...thinking, encrypted_content: "encrypted" },
          ],
          usage: { input_tokens: 3, output_tokens: 4 },
        },
      },
    );
    const r = await collect(
      upstreamEvents("openai-responses", bytes(output)),
      "m",
    );
    expect(r.text).toBe("Hi!");
    expect(r.calls).toEqual([
      { id: "call_1", name: "weather", arguments: "{}" },
    ]);
    expect(r.reasoning).toEqual([
      {
        source: "openai-responses",
        text: "why",
        encrypted: "encrypted",
        id: "rs_1",
      },
    ]);
  });
  it("supports done-only tools, sparse upstream indices and concurrent same-name tools", async () => {
    const r = await collect(
      upstreamEvents(
        "openai-responses",
        bytes(
          sse({
            type: "response.completed",
            response: {
              output: ["a", "b"].map((id, n) => ({
                id: "fc" + n,
                type: "function_call",
                call_id: id,
                name: "weather",
                arguments: "{}",
              })),
            },
          }),
        ),
      ),
      "m",
    );
    expect(r.calls.map((c) => c.id)).toEqual(["a", "b"]);
    const chat = await collect(
      upstreamEvents(
        "openai-chat",
        bytes(
          sse({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 23,
                      id: "c",
                      function: { name: "weather", arguments: "{}" },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }) + "data: [DONE]\n\n",
        ),
      ),
      "m",
    );
    expect(chat.calls).toEqual([{ id: "c", name: "weather", arguments: "{}" }]);
  });
  it("keeps Anthropic blocks sequential and emits full Responses item lifecycles", async () => {
    const source: AIEvent[] = [
      { type: "text", text: "a" },
      { type: "tool", index: 0, id: "c", name: "weather", arguments: '{"x":' },
      { type: "text", text: "b" },
      { type: "tool", index: 0, arguments: "1}", done: true },
      { type: "text", text: "c" },
      { type: "finish", reason: "tool_calls" },
    ];
    const anthro = await list(
      parseSSE(
        bytes(
          await new Response(
            encodeStream("anthropic", events(source), "m", signal()),
          ).text(),
        ),
      ),
    );
    let active: number | undefined;
    let count = 0;
    for (const raw of anthro) {
      const d = JSON.parse(raw.data);
      if (d.type === "content_block_start") {
        expect(active).toBeUndefined();
        expect(d.index).toBe(count++);
        active = d.index;
      }
      if (d.type === "content_block_delta") expect(d.index).toBe(active);
      if (d.type === "content_block_stop") {
        expect(d.index).toBe(active);
        active = undefined;
      }
    }
    expect(active).toBeUndefined();
    expect(count).toBe(3);
    expect(JSON.parse(anthro.at(-1)!.data).type).toBe("message_stop");
    const response = (
      await list(
        parseSSE(
          bytes(
            await new Response(
              encodeStream("openai-responses", events(source), "m", signal()),
            ).text(),
          ),
        ),
      )
    ).map((f) => JSON.parse(f.data));
    expect(response.map((e) => e.sequence_number)).toEqual(
      response.map((_, i) => i),
    );
    const added = response.filter(
      (e) => e.type === "response.output_item.added",
    );
    expect(added.map((e) => e.output_index)).toEqual([0, 1]);
    expect(
      response.filter((e) => e.type === "response.output_item.done"),
    ).toHaveLength(2);
    expect(response.at(-1).response.output[0].content[0].text).toBe("abc");
    expect(response.at(-1).response.output[1].call_id).toBe("c");
  });
  it("does not resend Gemini text at termination and preserves separate thinking signatures", async () => {
    const wire = await new Response(
      encodeStream(
        "gemini",
        resultEvents({ ...result(), calls: [], reason: "stop" }),
        "m",
        signal(),
      ),
    ).text();
    const out = await collect(upstreamEvents("gemini", bytes(wire)), "m");
    expect(out.text).toBe("你好");
    const r = await collect(
      upstreamEvents(
        "gemini",
        bytes(
          sse({
            candidates: [
              {
                content: {
                  parts: [
                    { text: "first", thought: true },
                    { thoughtSignature: "s1" },
                    { text: "second", thought: true },
                    { thoughtSignature: "s2" },
                    { text: "answer" },
                  ],
                },
                finishReason: "STOP",
              },
            ],
          }),
        ),
      ),
      "m",
    );
    expect(r.reasoning).toEqual([
      { source: "gemini", text: "first", signature: "s1" },
      { source: "gemini", text: "second", signature: "s2" },
    ]);
  });
  it("reports conversion failures to accounting and never emits a success terminal", async () => {
    const ctx = {
      state: new Map([
        ["ai.observation", { startedAt: Date.now(), protocol: "anthropic" }],
      ]),
    } as any;
    const onError = (e: any) => {
      ctx.state.get("ai.observation").errorCode = e.code ?? "stream_error";
    };
    const source: AIEvent[] = [
      { type: "usage", usage: { input: 1, output: 1 } },
      { type: "finish", reason: "stop" },
      { type: "text", text: "too late" },
    ];
    const output = await new Response(
      encodeStream(
        "anthropic",
        observeEvents(events(source), ctx),
        "m",
        signal(),
        { onError },
      ),
    ).text();
    expect(output).toContain('"type":"error"');
    expect(output).not.toContain('"type":"message_stop"');
    expect(ctx.state.get("ai.observation").errorCode).toBe("upstream_protocol");
  });
  it.each(protocols)(
    "emits %s failure on truncation without successful completion",
    async (p) => {
      const error = vi.fn();
      const text = await new Response(
        encodeStream(
          p,
          events([{ type: "text", text: "partial" }]),
          "m",
          signal(),
          { onError: error },
        ),
      ).text();
      expect(error).toHaveBeenCalledOnce();
      expect(text).toContain("Upstream stream failed");
      expect(text).not.toContain('"type":"response.completed"');
      expect(text).not.toContain("[DONE]");
      expect(text).not.toContain('"type":"message_stop"');
    },
  );
  it.each(protocols)(
    "redacts provider details while preserving the gateway's safe %s budget error",
    async (protocol) => {
      for (const code of ["provider_private", "upstream_budget_exceeded"]) {
        const source = (async function* () {
          yield { type: "text", text: "partial" } as AIEvent;
          throw new HostError(code, "private-provider-diagnostic");
        })();
        const text = await new Response(
          encodeStream(protocol, source, "m", signal()),
        ).text();
        expect(text).not.toContain("private-provider-diagnostic");
        expect(text).not.toContain("provider_private");
        expect(text).toContain(
          code === "upstream_budget_exceeded"
            ? "Upstream usage exceeded the output token limit"
            : "Upstream stream failed",
        );
      }
    },
  );
  it("paces text and tools without dropping signatures, opaque blocks or tool completion", async () => {
    const paced = await list(
      paceEvents(
        events([
          {
            type: "reasoning",
            source: "anthropic",
            index: 0,
            text: "think",
            signature: "sig",
          },
          {
            type: "tool",
            index: 0,
            id: "c",
            name: "weather",
            arguments: "{}",
            thoughtSignature: "gsig",
            done: true,
          },
          { type: "finish", reason: "tool_calls" },
        ]),
        (t) => t.length,
        async () => {},
        signal(),
      ),
    );
    const r = await collect(events(paced), "m");
    expect(r.reasoning?.[0]).toMatchObject({ text: "think", signature: "sig" });
    expect(r.calls[0]).toMatchObject({
      arguments: "{}",
      thoughtSignature: "gsig",
    });
    expect(paced.some((e) => e.type === "tool" && e.done)).toBe(true);
  });
});

describe("SSE framing and resource release", () => {
  it.each(["\n", "\r", "\r\n"])(
    "parses %j framing, UTF-8, multiline and EOF rules byte by byte",
    async (eol) => {
      const frames = await list(
        parseSSE(
          bytes(
            [
              ": comment",
              "event:",
              "data: 你好",
              "data: 世界",
              "",
              "data: uncommitted",
            ].join(eol),
          ),
        ),
      );
      expect(frames).toEqual([{ event: "message", data: "你好\n世界" }]);
    },
  );
  it("rejects invalid UTF-8 and oversized events", async () => {
    const bad = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([0xff]));
        c.close();
      },
    });
    await expect(list(parseSSE(bad))).rejects.toThrow("UTF-8");
    await expect(
      list(parseSSE(bytes("data: " + "x".repeat(1048577), 65536))),
    ).rejects.toThrow("too large");
  });
  it("cancels upstream before first read and after only the protocol header", async () => {
    for (const readHeader of [false, true]) {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({ cancel });
      const reader = encodeStream(
        "openai-chat",
        upstreamEvents("openai-chat", body),
        "m",
        signal(),
      ).getReader();
      if (readHeader) await reader.read();
      await reader.cancel();
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
    }
  });
  it("cancels while waiting on upstream data", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const reader = encodeStream(
      "gemini",
      upstreamEvents("gemini", body),
      "m",
      signal(),
    ).getReader();
    const pending = reader.read();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await reader.cancel();
    await pending;
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
  it("maps errors to canonical protocol types without leaking upstream server details", async () => {
    expect(
      await protocolError("gemini", new HostError("x", "slow", 429)).json(),
    ).toMatchObject({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } });
    expect(
      await protocolError("anthropic", new HostError("x", "login", 401)).json(),
    ).toMatchObject({ error: { type: "authentication_error" } });
    const response = protocolError("gemini", {
      status: 200,
      message: "secret",
    });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret");
  });
});
