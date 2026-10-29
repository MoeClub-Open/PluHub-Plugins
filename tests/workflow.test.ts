import { it, expect } from "vitest";
import type { ChannelWorkflow } from "@pluhub/contracts/workflow";
import { compileWorkflow, runWorkflow } from "../lib/ai/channel-graph.js";
import { checkProtocolConversion } from "../lib/ai/channel-graph.js";
const request = {
  model: "public",
  messages: [{ role: "user" as const, text: "hello" }],
  tools: [],
  stream: false,
  maxTokens: 12,
};
const flow: ChannelWorkflow = {
  entry: "start",
  nodes: [
    { id: "start", type: "start", next: "condition" },
    { id: "condition", type: "branch", condition: false, yes: "prompt", no: "plain" },
{ id: "condition-predicate", type: "predicate", test: "stream" },
    { id: "prompt", type: "prompt", text: "system", next: "budget" },
    { id: "budget", type: "maxTokens", limit: 8, next: "tps" },
    {
      id: "tps",
      type: "tps",
      rate: 30,
      tokenizer: "o200k_base",
      next: "reasoning",
    },
    { id: "reasoning", type: "reasoning", effort: "low", next: "rich" },
    { id: "rich", type: "upstream", target: "smart", mode: "explicit" },
    { id: "plain", type: "upstream", target: "fast", mode: "implicit" },
  ],
bindings: [{ source: "condition-predicate", output: "result", target: "condition", input: "condition" }]};
it("executes channel branches, bounded transforms and traces without modifying input", () => {
  const signal = new AbortController().signal;
  expect(runWorkflow("p", flow, request, signal).target).toBe("fast");
  const output = runWorkflow("p", flow, { ...request, stream: true }, signal);
  expect(output).toMatchObject({
    target: "smart",
    mode: "explicit",
    request: { maxTokens: 8, reasoning: { effort: "low" } },
    outputPolicy: { tps: 30 },
  });
  expect(output.request.messages[0]?.text).toBe("system");
  expect(output.trace.nodes).toEqual([
    "start",
    "condition",
    "prompt",
    "budget",
    "tps",
    "reasoning",
    "rich",
  ]);
  expect(request.messages).toHaveLength(1);
  expect(request.maxTokens).toBe(12);
});
it("rejects graph cycles, missing edges, unreachable and duplicate nodes", () => {
  expect(() => compileWorkflow({ ...flow, entry: "absent" })).toThrow();
  expect(() =>
    compileWorkflow({ ...flow, nodes: [...flow.nodes, flow.nodes[0]!] }),
  ).toThrow(/不能为空或重复/);
  expect(() =>
    compileWorkflow({
      ...flow,
      nodes: flow.nodes.map((n) =>
        n.id === "start" ? { id: "start", type: "start", next: "start" } : n,
      ),
    }),
  ).toThrow(/循环/);
  expect(() =>
    compileWorkflow({
      ...flow,
      nodes: flow.nodes.filter((n) => n.id !== "budget"),
    }),
  ).toThrow(/不存在/);
  expect(() =>
    compileWorkflow({
      ...flow,
      nodes: [
        ...flow.nodes,
        { id: "orphan", type: "upstream", target: "x", mode: "implicit" },
      ],
    }),
  ).toThrow(/未接入请求路径/);
});
it("honors cancellation before a workflow runs", () => {
  const controller = new AbortController();
  controller.abort();
  expect(() => runWorkflow("p", flow, request, controller.signal)).toThrow();
});
it("branches by requested or mapped model ID with exact and wildcard rules", () => {
  const flow: ChannelWorkflow = {
    entry: "s",
    nodes: [
      { id: "s", type: "start", next: "c" },
      { id: "c", type: "branch", condition: false, yes: "match", no: "other" },
{ id: "c-predicate", type: "predicate", test: "model", models: ["gpt-*", "claude-*-sonnet*"] },
      { id: "match", type: "provider" },
      { id: "other", type: "provider" },
    ],
  bindings: [{ source: "c-predicate", output: "result", target: "c", input: "condition" }]};
  const signal = new AbortController().signal;
  const context = { requestedModel: "public", mappedModel: "gpt-5" };
  expect(runWorkflow("p", flow, request, signal, context).providerId).toBe(
    "other",
  );
  (flow.nodes.find((node) => node.type === "predicate") as any).modelSource = "mapped";
  expect(runWorkflow("p", flow, request, signal, context).providerId).toBe(
    "match",
  );
  expect(
    runWorkflow("p", flow, request, signal, {
      mappedModel: "claude-4-sonnet-latest",
    }).providerId,
  ).toBe("match");
  (flow.nodes.find((node) => node.type === "predicate") as any).models = ["gpt-5"];
  expect(
    runWorkflow("p", flow, request, signal, { mappedModel: "gpt-5-mini" })
      .providerId,
  ).toBe("other");
  (flow.nodes.find((node) => node.type === "predicate") as any).models = [];
  expect(() => compileWorkflow(flow)).toThrow(/模型条件/);
});
it("validates protocol gates and maps subscription providers to their wire protocols", () => {
  const policy = { conversion: "disabled" as const };
  for (const [ingress, provider] of [
    ["openai-responses", "codex"],
    ["anthropic", "claude-subscription"],
    ["gemini", "antigravity"],
  ] as const) {
    expect(() =>
      checkProtocolConversion(ingress, provider, policy),
    ).not.toThrow();
    expect(() =>
      checkProtocolConversion("openai-chat", provider, policy),
    ).toThrow(/相同的协议/);
  }
  for (const allow of [[], ["invalid"], ["anthropic", "anthropic"]]) {
    expect(() =>
      compileWorkflow({
        entry: "s",
        nodes: [
          { id: "s", type: "start", next: "gate" },
          {
            id: "gate",
            type: "protocol",
            allow,
            conversion: "auto",
            next: "p",
          },
          { id: "p", type: "provider" },
        ],
      } as any),
    ).toThrow(/协议准入/);
  }
});
