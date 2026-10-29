import { describe, expect, it, vi } from "vitest";
import { HostError, type Host } from "@pluhub/sdk";
import { requestNativeDecision } from "../lib/ai/native-decision.js";

const signal = new AbortController().signal;
const connection = { baseUrl: "https://decision.example/v1", keyRef: "secret:DECISION", publicOnly: true };
const parse = (value: unknown) => (value as { choice: string }).choice;

function fakeHost(response: Response | Error) {
  const call = response instanceof Error
    ? vi.fn().mockRejectedValue(response)
    : vi.fn().mockResolvedValue(response);
  const secret = vi.fn().mockReturnValue("test-key");
  return { host: { call, secret } as unknown as Host, call, secret };
}

describe("metered native decision adapter", () => {
  it.each([["luna", "decisions"], ["jev", "decide"]] as const)(
    "sends %s native body using its authorized connection",
    async (kind, path) => {
      const { host, call, secret } = fakeHost(Response.json({ model: "actual-version", choice: "hard", usage: { input_tokens: 12, output_tokens: 4 } }));
      const body = { state: "task", question: "difficulty" };
      const result = await requestNativeDecision(host, kind, connection, body, parse, signal);
      expect(result).toEqual({ decision: "hard", usage: { input: 12, output: 4 }, upstreamModel: "actual-version" });
      expect(secret).toHaveBeenCalledWith("secret:DECISION");
      expect(call).toHaveBeenCalledWith("http.transport@1", expect.objectContaining({
        url: `https://decision.example/v1/${path}`,
        publicOnly: true,
        headers: { "content-type": "application/json", authorization: "Bearer test-key" },
        body: JSON.stringify(body),
      }), expect.any(AbortSignal));
    },
  );

  it("never invents usage and preserves reported usage when parsing fails", async () => {
    const absent = fakeHost(Response.json({ choice: "easy" }));
    expect(await requestNativeDecision(absent.host, "jev", connection, {}, parse, signal)).toEqual({ decision: "easy" });
    const bad = fakeHost(Response.json({ usage: { input_tokens: 6, output_tokens: 2 } }));
    await expect(requestNativeDecision(bad.host, "luna", connection, {}, () => {
      throw new HostError("invalid_decision", "invalid", 502);
    }, signal)).rejects.toMatchObject({ code: "invalid_decision", usage: { input: 6, output: 2 } });
  });

  it("distinguishes explicit rejection from an unknown network outcome", async () => {
    const rejected = fakeHost(new Response(null, { status: 429 }));
    await expect(requestNativeDecision(rejected.host, "jev", connection, {}, parse, signal))
      .rejects.toMatchObject({ generationRejected: true });
    const failed = fakeHost(new Error("network"));
    await expect(requestNativeDecision(failed.host, "luna", connection, {}, parse, signal))
      .rejects.not.toHaveProperty("generationRejected");
  });
});
