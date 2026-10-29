import { expect, it } from "vitest";
import type { ChannelWorkflow } from "@pluhub/contracts/workflow";
import { needsDeferredWorkflow, resolveRoute } from "../plugins/ai-router/resolution.js";
import { planRoute } from "../plugins/ai-router/planning.js";

const task = { model: "public", messages: [{ role: "user" as const, text: "hello" }], tools: [], stream: false };
const signal = new AbortController().signal;

it("defers a formatted value connected directly to an execution node", () => {
  const flow: ChannelWorkflow = { entry: "start", nodes: [
    { id: "start", type: "start", next: "prompt" },
    { id: "prompt", type: "prompt", text: "default", next: "provider" },
    { id: "provider", type: "provider" },
    { id: "format", type: "format", value: { label: "test" } },
  ], bindings: [{ source: "format", output: "text", target: "prompt", input: "text" }] };
  expect(needsDeferredWorkflow(flow)).toBe(true);
});

it("defers only data needed by a reachable execution node", () => {
  const flow: ChannelWorkflow = {
    entry: "start",
    nodes: [
      { id: "start", type: "start", next: "provider" },
      { id: "provider", type: "provider" },
      { id: "answer", type: "llm", model: "other", promptMode: "append" },
      { id: "template", type: "template", template: "{{answer}}", values: { answer: "" } },
    ],
    bindings: [{ source: "answer", output: "text", target: "template", input: "values.answer" }],
  };
  expect(needsDeferredWorkflow(flow)).toBe(false);
  flow.nodes.splice(1, 0, { id: "prompt", type: "prompt", text: "text", next: "provider" });
  (flow.nodes[0] as Extract<ChannelWorkflow["nodes"][number], { type: "start" }>).next = "prompt";
  flow.bindings!.push({ source: "template", output: "text", target: "prompt", input: "text" });
  expect(needsDeferredWorkflow(flow)).toBe(true);
});

it("selects the matching Jev or chat provider when both expose the same public model", async () => {
  const config = {
    upstreams: {
      chat: { protocol: "openai-chat", baseUrl: "https://chat.example" },
      jev: { flow: { entry: "start", nodes: [
        { id: "start", type: "start", next: "provider" },
        { id: "provider", type: "provider", upstream: { protocol: "systemone", baseUrl: "https://jev.example" } },
      ] } },
    },
    models: {
      chatRoute: { publicModel: "shared", upstream: "chat", model: "chat-model" },
      jevRoute: { publicModel: "shared", upstream: "jev", model: "jev-model" },
    },
  };
  const host = { config: () => config, hasCapability: () => true, call: () => { throw Error("unexpected call"); } } as any;
  const base = { model: "shared", request: { ...task, model: "shared" }, features: ["text"] as const, principalId: "user", ingressProtocol: "openai-chat" as const };
  expect((await planRoute(host, base, signal)).model).toBe("chat-model");
  expect((await planRoute(host, { ...base, routeKind: "systemone" }, signal)).model).toBe("jev-model");
});

it("tries another matching channel when a static mixed graph resolves to the wrong protocol", async () => {
  const config = {
    upstreams: {
      mixed: { priority: 5, flow: { entry: "start", nodes: [
        { id: "start", type: "start", next: "choice" },
        { id: "choice", type: "branch", condition: false, yes: "chat", no: "jev" },
{ id: "choice-predicate", type: "compare", valueType: "boolean", operator: "eq", left: false, right: true },
        { id: "chat", type: "provider", upstream: { protocol: "openai-chat", baseUrl: "https://chat.example" } },
        { id: "jev", type: "provider", upstream: { protocol: "systemone", baseUrl: "https://jev.example" } },
      ] ,bindings: [{ source: "start", output: "hasTools", target: "choice-predicate", input: "left" },
{ source: "choice-predicate", output: "result", target: "choice", input: "condition" }]} },
      chat: { protocol: "openai-chat", baseUrl: "https://chat.example" },
    },
    models: {
      mixedRoute: { publicModel: "shared", upstream: "mixed", model: "mixed-model" },
      chatRoute: { publicModel: "shared", upstream: "chat", model: "chat-model" },
    },
  };
  const host = { config: () => config, hasCapability: () => true, call: () => { throw Error("unexpected call"); } } as any;
  const base = { model: "shared", request: { ...task, model: "shared" }, features: ["text"] as const, principalId: "user", ingressProtocol: "openai-chat" as const };
  expect((await planRoute(host, base, signal)).model).toBe("chat-model");
});

it("does not execute a dynamic workflow during planning or price quotation", async () => {
  const flow: ChannelWorkflow = {
    entry: "start",
    nodes: [
      { id: "start", type: "start", next: "response" },
      { id: "response", type: "response", text: "" },
      { id: "answer", type: "llm", model: "other", promptMode: "append" },
    ],
    bindings: [{ source: "answer", output: "text", target: "response", input: "text" }],
  };
  const config = { upstreams: { channel: { flow } }, models: { public: { upstream: "channel", model: "remote" } } };
  const host = { config: () => config, hasCapability: () => true, call: () => { throw Error("unexpected paid call"); } } as any;
  const input = { model: "public", request: task, features: ["text"] as const, principalId: "user", ingressProtocol: "openai-chat" as const };
  const planned = await resolveRoute(host, input, signal, "public");
  expect(planned.plan.workflowDeferred?.input).toEqual(input);
  await expect(resolveRoute(host, { ...input, purpose: "quote" }, signal, "public")).rejects.toMatchObject({ code: "quote_route_required" });
  const resolved = await resolveRoute(host, input, signal, "public", {
    runWorkflow: async (_profile, _flow, request) => ({ request, target: "", mode: "implicit", trace: { profile: "channel", nodes: ["start", "response"] }, responseText: "" }),
  });
  expect(resolved.plan.workflowResponse).toEqual({ text: "" });
  expect(resolved.plan.pricing).toBeUndefined();
});

it("rejects request-dependent conditions during a request-free quotation", async () => {
  const flow: ChannelWorkflow = {
    entry: "start",
    nodes: [
      { id: "start", type: "start", next: "branch" },
      { id: "branch", type: "branch", condition: false, yes: "yes", no: "no" },
      { id: "yes", type: "provider" },
      { id: "no", type: "provider" },
      { id: "predicate", type: "compare", valueType: "boolean", operator: "eq", left: false, right: true },
    ],
    bindings: [{ source: "start", output: "hasTools", target: "predicate", input: "left" },
{ source: "predicate", output: "result", target: "branch", input: "condition" }],
  };
  const config = { upstreams: { channel: { flow } }, models: { public: { upstream: "channel", model: "remote" } } };
  const host = { config: () => config, hasCapability: () => true } as any;
  await expect(resolveRoute(host, { model: "public", purpose: "quote", features: ["text"] }, signal, "public"))
    .rejects.toMatchObject({ code: "quote_request_required" });
});

it("retains deferred execution through a personal channel's platform delegation", async () => {
  const inner: ChannelWorkflow = { entry: "start", nodes: [
    { id: "start", type: "start", next: "response" },
    { id: "response", type: "response", text: "done" },
  ] };
  const outer: ChannelWorkflow = { entry: "start", nodes: [
    { id: "start", type: "start", next: "platform" },
    { id: "platform", type: "platform", groupId: "default", model: "target" },
  ] };
  const config = { upstreams: { platform: { flow: inner } }, models: { target: { upstream: "platform", model: "remote" } } };
  const channel = { id: "personal:one", enabled: true, upstream: { flow: outer }, models: { public: { upstream: "personal:one", model: "remote" } } };
  const host = {
    config: () => config,
    hasCapability: () => true,
    async call(name: string, input: any) {
      if (name === "ai.user-channels@1") return [channel];
      if (name === "ai.routing@2") return { kind: "workflow", model: "target", workflowDeferred: { input, requestedModel: "target" } };
      throw Error("unexpected call " + name);
    },
  } as any;
  const input = { model: "public", channelId: "personal:one", request: task, features: ["text"] as const, principalId: "user", ingressProtocol: "openai-chat" as const };
  expect((await resolveRoute(host, input, signal, "public")).plan.workflowDeferred?.input).toEqual(input);
  let calls = 0;
  const completed = await resolveRoute(host, input, signal, "public", {
    runWorkflow: async (_profile, _flow, request) => {
      calls++;
      return { request, target: "", mode: "implicit", trace: { profile: "platform", nodes: ["start", "response"] }, responseText: "done" };
    },
  });
  expect(calls).toBe(1);
  expect(completed.plan.workflowResponse?.text).toBe("done");
  expect(completed.plan.workflows?.map((item) => item.profile)).toEqual(["personal:one", "platform"]);
});

it("rejects a group-bound request targeting a personal channel during resumed routing", async () => {
  const host = { config: () => ({}) } as any;
  const input = { model: "public", channelId: "personal:one", groupId: "restricted", request: task, features: ["text"] as const, principalId: "user" };
  await expect(resolveRoute(host, input, signal, "public"))
    .rejects.toMatchObject({ code: "channel_forbidden" });
});
