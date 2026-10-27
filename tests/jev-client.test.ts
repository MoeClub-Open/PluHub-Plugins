import { describe, expect, it, vi } from "vitest";
import type { Host } from "@pluhub/sdk";
import { requestJev, type JevRequest } from "../lib/ai/jev.js";

const request: JevRequest = {
  model: "jev-latest",
  state: { task: "Route this request" },
  questions: {
    route: {
      type: "choice",
      instructions: "Choose a route",
      criteria: { fast: "Simple", strong: "Complex" },
    },
  },
};

function fakeHost(response: Response) {
  const call = vi.fn().mockResolvedValue(response);
  const secret = vi.fn().mockReturnValue("test-key");
  return { host: { call, secret } as unknown as Host, call, secret };
}

describe("System One client", () => {
  it("sends a native request and returns actual usage", async () => {
    const { host, call, secret } = fakeHost(Response.json({
      model: "jev-1.13.0",
      answers: { route: { type: "choice", choice: "fast" } },
      usage: { input_tokens: 42, output_tokens: 3 },
    }));
    const result = await requestJev(host, {
      baseUrl: "https://api.example/v1",
      keyRef: "secret:JEV",
      publicOnly: true,
    }, request, new AbortController().signal);
    expect(result).toEqual({
      model: "jev-1.13.0",
      answers: { route: { type: "choice", choice: "fast" } },
      usage: { input: 42, output: 3 },
    });
    expect(secret).toHaveBeenCalledWith("secret:JEV");
    const [capability, input] = call.mock.calls[0]!;
    expect(capability).toBe("http.transport@1");
    expect(input.url).toBe("https://api.example/v1/systemone");
    expect(input.publicOnly).toBe(true);
    expect(JSON.parse(input.body)).toEqual(request);
    expect(input.headers.authorization).toBe("Bearer test-key");
  });

  it("does not invent usage and retains known usage on an invalid result", async () => {
    const signal = new AbortController().signal;
    const withoutUsage = fakeHost(Response.json({ model: "jev", answers: { route: { type: "choice", choice: "fast" } } }));
    expect((await requestJev(withoutUsage.host, { baseUrl: "https://api.example" }, request, signal)).usage).toBeUndefined();
    const malformed = fakeHost(Response.json({
      model: "jev", answers: null, usage: { input_tokens: 9, output_tokens: 2 },
    }));
    await expect(requestJev(malformed.host, { baseUrl: "https://api.example" }, request, signal))
      .rejects.toMatchObject({ code: "upstream_protocol", usage: { input: 9, output: 2 } });
    const invalidChoice = fakeHost(Response.json({
      model: "jev", answers: { route: { type: "choice", choice: "other" } },
      usage: { input_tokens: 9, output_tokens: 2 },
    }));
    await expect(requestJev(invalidChoice.host, { baseUrl: "https://api.example" }, request, signal))
      .rejects.toMatchObject({ code: "upstream_protocol", usage: { input: 9, output: 2 } });
  });
});
