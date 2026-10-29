import { expect, it } from "vitest";
import { readCatalog } from "../plugins/ai-router/catalog.js";
import { planRoute } from "../plugins/ai-router/planning.js";

it("filters directory audiences without changing direct routing or owner-provided models", async () => {
  const statuses: Record<string, { paid: boolean; consumed: boolean }> = {
    free: { paid: false, consumed: false },
    used: { paid: false, consumed: true },
    paid: { paid: true, consumed: false },
  };
  const config = {
    upstreams: {
      c: { protocol: "openai-chat", baseUrl: "https://example.com" },
    },
    models: Object.fromEntries(
      [
        ["public", undefined],
        ["signed", "authenticated"],
        ["used", "consumed"],
        ["gpt-test", "paid"],
      ].map(([id, visibility]) => [
        id,
        { upstream: "c", model: id, inputPrice: 1, outputPrice: 2, visibility },
      ]),
    ),
  };
  const host = {
    config: () => config,
    hasCapability: () => true,
    call: async (capability: string, input: any) => {
      if (capability === "billing.customer-status@1")
        return statuses[input.userId];
      if (capability === "billing.personal-pricing@1")
        return { mode: "request", request: 0.002, input: 0, output: 0 };
      if (capability === "ai.user-channels@1")
        return [
          {
            id: "personal:own",
            name: "Mine",
            enabled: true,
            upstream: { protocol: "openai-chat" },
            models: { mine: { upstream: "personal:own", model: "gpt-test" } },
          },
        ];
      throw Error(capability);
    },
  } as any;
  const ids = async (principalId?: string) =>
    (await readCatalog(host, { principalId })).map((model) => model.id);
  expect(await ids()).toEqual(["public"]);
  expect(await ids("free")).toEqual(["public", "signed"]);
  expect(await ids("used")).toEqual(["public", "signed", "used"]);
  expect(await ids("paid")).toEqual(["public", "signed", "gpt-test"]);
  const own = await readCatalog(host, {
    principalId: "free",
    includePersonal: true,
  });
  expect(own.find((model) => model.id === "mine")).toMatchObject({
    requestFee: 0.002,
  });
  const plan = await planRoute(
    host,
    {
      model: "gpt-test",
      groupId: "default",
      principalId: "free",
      features: ["text"],
      request: { model: "gpt-test", messages: [], tools: [], stream: false },
    },
    new AbortController().signal,
  );
  expect(plan.model).toBe("gpt-test");
});
