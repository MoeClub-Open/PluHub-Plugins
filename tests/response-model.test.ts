import { expect, it } from "vitest";
import { executeRequest } from "../lib/ai/execution.js";
import { responseModel } from "../lib/ai/response-model.js";

it("extracts response model IDs from each supported protocol without substituting missing values", () => {
  expect(responseModel("openai-chat", { model: "chat-id" })).toBe("chat-id");
  expect(responseModel("openai-chat", { model: "chat-stream-id" }, true)).toBe("chat-stream-id");
  expect(responseModel("openai-responses", { model: "responses-id" })).toBe("responses-id");
  expect(responseModel("openai-responses", { response: { model: "responses-stream-id" } }, true)).toBe("responses-stream-id");
  expect(responseModel("anthropic", { model: "anthropic-id" })).toBe("anthropic-id");
  expect(responseModel("anthropic", { type: "message_start", message: { model: "anthropic-stream-id" } }, true)).toBe("anthropic-stream-id");
  expect(responseModel("gemini", { modelVersion: "gemini-id" })).toBe("gemini-id");
  expect(responseModel("gemini", { modelVersion: "gemini-stream-id" }, true)).toBe("gemini-stream-id");
  expect(responseModel("openai-chat", {})).toBeUndefined();
  expect(responseModel("openai-chat", { model: "x".repeat(257) })).toBeUndefined();
});

it.each([true, false])("preserves fallback and applies the selected provider's response model setting (%s)", async (recordResponseModel) => {
  let calls = 0;
  const host = {
    hasCapability: () => false,
    async call(capability: string) {
      if (capability === "ai.execution@1") {
        calls++;
        if (calls === 1) return (async function* () {
          yield { type: "upstream-model", model: "rejected-model" };
          throw Object.assign(new Error("rejected"), { generationRejected: true, retryable: true });
        })();
        return (async function* () {
          yield { type: "upstream-model", model: "backup-model" };
          yield { type: "text", text: "ok" };
          yield { type: "finish", reason: "stop" };
        })();
      }
      if (capability === "ai.routing@2")
        return {kind: "provider",  capability: "backup", upstream: {}, model: "backup-target", recordResponseModel };
    },
  };
  const state = new Map<string, any>([["ai.observation", { startedAt: Date.now(), protocol: "openai-chat" }]]);
  const ctx = { state } as any;
  const request = { model: "public", messages: [], tools: [], stream: true } as any;
  const plan = {kind: "provider",  capability: "primary", upstream: {}, model: "primary-target", recordResponseModel: true, fallback: {} } as any;
  const events = await executeRequest(host as any, ctx, request, plan, new AbortController().signal);
  const types: string[] = [];
  for await (const event of events) types.push(event.type);
  expect(calls).toBe(2);
  expect(types).toEqual(["text", "finish"]);
  expect(state.get("ai.observation").upstreamResponseModel).toBe(recordResponseModel ? "backup-model" : undefined);
});
