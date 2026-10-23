import { it, expect } from "vitest";
import { generateKeyPairSync, createHmac } from "node:crypto";
import {
  epaySign,
  epayVerify,
  canonical,
  stripeVerify,
} from "../lib/commerce/signatures.js";
import { minorAmount } from "../lib/commerce/money.js";
import { priceUsage } from "../lib/commerce/pricing.js";
import { subscriptionRequest } from "../lib/ai/subscription.js";
import { throttle } from "../plugins/rate-limit/throttle.js";
import { nextPeriod } from "../plugins/commerce/period.js";
import { decodeResult } from "../lib/ai/protocols.js";
import { upstreamEvents } from "../lib/ai/streams.js";
it("uses canonical unescaped Epay parameters and rejects signature algorithm substitution", () => {
  const input = {
    name: "a b&c",
    money: "1.00",
    pid: "1",
    empty: "",
    sign_type: "MD5",
  };
  expect(canonical(input)).toBe("money=1.00&name=a b&c&pid=1");
  const signed = { ...input, sign: epaySign(input, "MD5", "secret") };
  expect(epayVerify(signed, "MD5", "secret")).toBe(true);
  expect(epayVerify({ ...signed, money: "2.00" }, "MD5", "secret")).toBe(false);
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const rsa = {
    ...input,
    sign_type: "RSA",
    sign: epaySign(input, "RSA", pair.privateKey),
  };
  expect(epayVerify(rsa, "RSA", pair.publicKey)).toBe(true);
  expect(epayVerify({ ...rsa, sign_type: "MD5" }, "RSA", pair.publicKey)).toBe(
    false,
  );
});
it("checks Stripe original bytes, multiple v1 signatures, timestamps and exact integer money", () => {
  const t = Math.floor(Date.now() / 1000),
    raw = Buffer.from('{ "x":1 }');
  const hash = createHmac("sha256", "s")
    .update(t + ".")
    .update(raw)
    .digest("hex");
  expect(() =>
    stripeVerify(raw, `t=${t},v1=old,v1=${hash}`, "s"),
  ).not.toThrow();
  expect(() =>
    stripeVerify(Buffer.from('{"x":1}'), `t=${t},v1=${hash}`, "s"),
  ).toThrow();
  expect(() =>
    stripeVerify(raw, `t=${t},v1=${hash}`, "s", (t + 301) * 1000),
  ).toThrow();
  expect(minorAmount("0.10")).toBe(10);
  expect(() => minorAmount("1e3")).toThrow();
  expect(
    priceUsage({ input: 1, output: 1 }, { input: 0.1, output: 0.2 }).amount,
  ).toBe(1);
  expect(() =>
    priceUsage({ input: NaN, output: 0 }, { input: 1, output: 1 }),
  ).toThrow();
});
it("builds explicit Codex, Claude OAuth and Antigravity envelopes without forwarding client authorization", () => {
  const req = {
    model: "m",
    messages: [{ role: "user" as const, text: "hello" }],
    stream: true,
    tools: [],
  };
  const codex = subscriptionRequest(
    "codex",
    req,
    {
      protocol: "codex",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      keyRef: "env:T",
      authMode: "cli",
    },
    { secret: "oauth", accountId: "account" },
  );
  expect(codex.url).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(codex.body).toMatchObject({ stream: true, store: false });
  expect(codex.headers["chatgpt-account-id"]).toBe("account");
  expect(() =>
    subscriptionRequest(
      "codex",
      { ...req, maxTokens: 5 },
      {
        protocol: "codex",
        baseUrl: "https://test",
        keyRef: "env:T",
        authMode: "cli",
      },
      { secret: "x" },
    ),
  ).toThrow("does not support");
  const claude = subscriptionRequest(
    "claude-subscription",
    req,
    {
      protocol: "claude-subscription",
      baseUrl: "https://api.anthropic.com",
      keyRef: "env:T",
    },
    { secret: "oauth" },
  );
  expect(claude.headers.authorization).toBe("Bearer oauth");
  expect(claude.headers["x-api-key"]).toBeUndefined();
  expect(claude.headers["anthropic-beta"]).toContain("oauth-");
  const google = subscriptionRequest(
    "antigravity",
    req,
    {
      protocol: "antigravity",
      baseUrl: "https://cloudcode-pa.googleapis.com",
      keyRef: "env:T",
    },
    { secret: "oauth", projectId: "p" },
  );
  expect(google.body).toMatchObject({
    project: "p",
    model: "m",
    requestType: "agent",
    request: { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
  });
  expect(google.url).toContain("streamGenerateContent?alt=sse");
  expect(
    subscriptionRequest(
      "antigravity",
      { ...req, stream: false },
      {
        protocol: "antigravity",
        baseUrl: "https://cloudcode-pa.googleapis.com",
        keyRef: "env:T",
      },
      { secret: "oauth", projectId: "p" },
    ).url,
  ).toBe(google.url);
});
it("cancels a paced response while waiting and closes its source", async () => {
  let cancelled = false;
  const abort = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      c.enqueue(new Uint8Array(4096));
    },
    cancel() {
      cancelled = true;
    },
  });
  const reader = throttle(body, 10, abort.signal).getReader();
  expect((await reader.read()).done).toBe(false);
  const pending = reader.read();
  abort.abort();
  await expect(pending).rejects.toThrow();
  expect(cancelled).toBe(true);
});

it("clamps monthly and yearly prepaid periods to valid UTC calendar dates", () => {
  expect(
    new Date(nextPeriod(Date.UTC(2027, 0, 31, 12), "month")).toISOString(),
  ).toBe("2027-02-28T12:00:00.000Z");
  expect(
    new Date(nextPeriod(Date.UTC(2028, 1, 29, 12), "year")).toISOString(),
  ).toBe("2029-02-28T12:00:00.000Z");
});

it("counts cached input and thought output while refusing to fabricate missing stream usage", async () => {
  expect(
    decodeResult(
      "anthropic",
      {
        content: [{ type: "text", text: "ok" }],
        usage: {
          input_tokens: 3,
          output_tokens: 4,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 6,
        },
      },
      "m",
    ).usage,
  ).toEqual({ input: 14, output: 4, cacheRead: 6, cacheWrite: 5 });
  expect(
    decodeResult(
      "gemini",
      {
        candidates: [{ content: { parts: [{ text: "ok" }] } }],
        usageMetadata: {
          promptTokenCount: 2,
          candidatesTokenCount: 3,
          thoughtsTokenCount: 5,
        },
      },
      "m",
    ).usage,
  ).toEqual({ input: 2, output: 8, reasoning: 5 });
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(
        new TextEncoder().encode(
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3}}\n\ndata: [DONE]\n\n',
        ),
      );
      c.close();
    },
  });
  const events = [];
  for await (const event of upstreamEvents("openai-chat", body))
    events.push(event);
  expect(events).toEqual([{ type: "finish", reason: "stop" }]);
});
