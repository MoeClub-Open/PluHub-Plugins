import { expect, it } from "vitest";
import {
  readMedia,
  mediaUsage,
  readBytes,
  validateOperations,
} from "../lib/ai/media.js";
import { outputBudget } from "../lib/ai/output-budget.js";
import type { AIPlan } from "@pluhub/contracts/ai";

const jsonRequest = (body: unknown) =>
  new Request("http://localhost", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
it("validates media inputs and endpoint declarations before dispatch", async () => {
  for (const input of [
    "hello",
    [1, 2, 3],
    ["hello", "world"],
    [
      [1, 2],
      [3, 4],
    ],
  ])
    expect(
      (await readMedia(jsonRequest({ model: "embed", input }), "embeddings"))
        .operation?.input.input,
    ).toEqual(input);
  for (const input of [[], [null], [[1], ["bad"]], ""])
    await expect(
      readMedia(jsonRequest({ model: "embed", input }), "embeddings"),
    ).rejects.toThrow();
  await expect(
    readMedia(
      jsonRequest({ model: "embed", input: "hello", stream: true }),
      "embeddings",
    ),
  ).rejects.toThrow();
  await expect(
    readMedia(
      jsonRequest({ model: "image", prompt: "cat", n: -1 }),
      "images/generations",
    ),
  ).rejects.toThrow();
  await expect(
    readMedia(jsonRequest({ model: "image", prompt: "cat" }), "images/edits"),
  ).rejects.toThrow();
  expect(() => validateOperations([])).toThrow();
  expect(() =>
    validateOperations(["images/generations", "embeddings"]),
  ).not.toThrow();
});
it("preserves multipart files and repeated fields without trusting duplicate model selectors", async () => {
  const form = new FormData();
  form.set("model", "image");
  form.set("prompt", "edit");
  form.set("stream", "false");
  form.append("image[]", new Blob(["one"], { type: "image/png" }), "one.png");
  form.append("image[]", new Blob(["two"], { type: "image/png" }), "two.png");
  const make = () =>
    new Request("http://localhost", { method: "POST", body: form });
  const request = await readMedia(make(), "images/edits");
  expect(request.stream).toBe(false);
  expect(
    request.operation?.parts
      ?.filter((p) => p.name === "image[]")
      .map((p) => (p.value as any).filename),
  ).toEqual(["one.png", "two.png"]);
  form.append("model", "another");
  await expect(readMedia(make(), "images/edits")).rejects.toThrow(
    "Duplicate model",
  );
});
it("uses token accounting for embeddings and fixed pricing for media without fabricating usage", async () => {
  expect(mediaUsage("embeddings", { usage: { prompt_tokens: 8 } })).toEqual({
    input: 8,
    output: 0,
  });
  expect(
    mediaUsage("audio/transcriptions", {
      usage: { type: "duration", seconds: 4 },
    }),
  ).toBeUndefined();
  expect(mediaUsage("images/generations", {})).toBeUndefined();
  const request = await readMedia(
    jsonRequest({ model: "image", prompt: "cat" }),
    "images/generations",
  );
  const plan = {
    upstream: { protocol: "openai-chat" },
    pricing: { input: 1, output: 2 },
  } as AIPlan;
  expect(() => outputBudget(request, plan, {})).toThrow("per-request");
  const fixed = outputBudget(
    request,
    {
      ...plan,
      pricing: { input: 0, output: 0, mode: "request", request: 0.04 },
    },
    {},
  );
  expect(fixed.budget).toEqual({
    mode: "fixed",
    source: "default",
    reservedTokens: 0,
  });
  expect(fixed.request).toBe(request);
});
it("cancels oversized and aborted media readers", async () => {
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      c.enqueue(new Uint8Array(20));
    },
    cancel() {
      cancelled++;
    },
  });
  await expect(
    readBytes(body, 16, new AbortController().signal),
  ).rejects.toThrow("limit");
  expect(cancelled).toBe(1);
  const controller = new AbortController();
  const pending = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled++;
    },
  });
  const read = readBytes(pending, 16, controller.signal);
  controller.abort(new Error("cancel-media"));
  await expect(read).rejects.toThrow("cancel-media");
  expect(cancelled).toBe(2);
});
