import { expect, it } from "vitest";
import type { AIPlan, AIRequest } from "@pluhub/contracts/ai";
import { planRoute } from "../plugins/ai-router/planning.js";
import { resolveRoute } from "../plugins/ai-router/resolution.js";
import { outputBudget } from "../lib/ai/output-budget.js";

const signal = new AbortController().signal;
const request: AIRequest = {
  model: "shared",
  messages: [{ role: "user", text: "task" }],
  tools: [],
  stream: false,
};
const base = {
  model: "shared",
  request,
  principalId: "user",
  ingressProtocol: "openai-chat" as const,
  features: ["text"] as const,
};
const decisionKinds = ["systemone", "luna", "jev"] as const;

it("selects only the requested protocol when chat and decision channels share a public model", async () => {
  const upstreams = Object.fromEntries(
    ["openai-chat", ...decisionKinds].map((protocol) => [
      protocol,
      { protocol, baseUrl: `https://${protocol}.example` },
    ]),
  );
  const models = Object.fromEntries(
    Object.keys(upstreams).map((protocol) => [
      `${protocol}-route`,
      { publicModel: "shared", upstream: protocol, model: `${protocol}-model` },
    ]),
  );
  const host = {
    config: () => ({ upstreams, models }),
    hasCapability: () => true,
    call: () => { throw Error("Unexpected provider call while planning"); },
  } as any;

  expect((await planRoute(host, base, signal)).upstream.protocol).toBe("openai-chat");
  for (const routeKind of decisionKinds) {
    const plan = await planRoute(host, { ...base, routeKind }, signal);
    expect(plan.upstream.protocol).toBe(routeKind);
    expect(plan.capability).toBe(`ai.upstream.${routeKind}@1`);
    expect(plan.model).toBe(`${routeKind}-model`);
  }
});

it("does not route ordinary chat to a decision-only model", async () => {
  for (const protocol of decisionKinds) {
    const config = {
      upstreams: { decision: { protocol, baseUrl: "https://decision.example" } },
      models: { shared: { upstream: "decision", model: "remote" } },
    };
    const host = { config: () => config, hasCapability: () => true } as any;
    await expect(planRoute(host, base, signal)).rejects.toMatchObject({ code: "route_kind_mismatch" });
  }
});

it("does not recursively invoke automatic chat routing for any decision protocol", async () => {
  const config = {
    upstreams: { routing: { protocol: "auto-router" } },
    models: { shared: { upstream: "routing", model: "profile" } },
  };
  const host = {
    config: () => config,
    hasCapability: () => true,
    call: () => { throw Error("Automatic router must not be called"); },
  } as any;
  for (const routeKind of decisionKinds)
    await expect(resolveRoute(host, { ...base, routeKind }, signal, "shared"))
      .rejects.toMatchObject({ code: "operation_not_supported" });
});

it("uses estimation or a fixed price for decision protocols that cannot enforce an output limit", () => {
  for (const protocol of decisionKinds) {
    const plan: AIPlan = {kind: "provider", 
      model: "remote",
      capability: `ai.upstream.${protocol}@1`,
      upstream: { protocol },
      pricing: { input: 1, output: 2 },
    };
    const estimated = outputBudget(request, plan, {});
    expect(estimated.budget).toMatchObject({ mode: "estimate", reservedTokens: 4096 });
    expect(estimated.request.maxTokens).toBeUndefined();
    expect(() => outputBudget(request, plan, { outputBudgetMode: "bounded" })).toThrow("cannot enforce");
    plan.pricing = { input: 0, output: 0, mode: "request", request: 0.01 };
    expect(outputBudget(request, plan, { outputBudgetMode: "bounded" }).budget)
      .toMatchObject({ mode: "fixed", reservedTokens: 0 });
  }
});
