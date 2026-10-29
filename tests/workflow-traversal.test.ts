import { expect, it } from "vitest";
import type { AIRequest } from "@pluhub/contracts/ai";
import type { ChannelWorkflow } from "@pluhub/contracts/workflow";
import { runWorkflow } from "../lib/ai/channel-graph.js";
import { createWorkflowDataGraph } from "../lib/ai/workflow-data.js";
import { runWorkflowPath } from "../lib/ai/workflow-path.js";

const request: AIRequest = {
  model: "public",
  tools: [],
  stream: false,
  messages: [{ role: "user", text: "hello" }],
};
const signal = new AbortController().signal;

it("reevaluates a reused request predicate after preceding request transformations", async () => {
  const flow: ChannelWorkflow = {
    entry: "start",
    nodes: [
      { id: "start", type: "start", next: ["first"] },
      {
        id: "first",
        type: "branch",
        condition: false,
        yes: "yes",
        no: "prompt",
      },
      { id: "prompt", type: "prompt", text: "system prompt", next: "second" },
      { id: "second", type: "branch", condition: false, yes: "yes", no: "no" },
      { id: "yes", type: "provider" },
      { id: "no", type: "provider" },
      {
        id: "length",
        type: "compare",
        valueType: "number",
        operator: "gt",
        left: 0,
        right: 10,
      },
    ],
    bindings: [
      {
        source: "start",
        output: "textLength",
        target: "length",
        input: "left",
      },
      ...["first", "second"].map((target) => ({
        source: "length",
        output: "result",
        target,
        input: "condition",
      })),
    ],
  };
  const task = structuredClone(request);
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected paid call");
  };
  const graph = createWorkflowDataGraph({
    flow,
    request: task,
    signal,
    callLLM: unexpected,
    callJev: unexpected,
  });
  const result = await runWorkflowPath("channel", flow, task, graph, signal);
  expect(result).toEqual(runWorkflow("channel", flow, request, signal));
  expect(result.providerId).toBe("yes");
});

it("applies the same transforms, limits and bound fallback in both execution modes", async () => {
  const flow: ChannelWorkflow = {
    entry: "start",
    nodes: [
      { id: "start", type: "start", next: ["prompt"] },
      { id: "prompt", type: "prompt", text: "system", next: "limit" },
      { id: "limit", type: "rateLimit", rule: { rpm: 4 }, next: "budget" },
      { id: "budget", type: "maxTokens", limit: 5, next: "provider" },
      { id: "provider", type: "provider", fallback: "platform" },
      { id: "platform", type: "platform", channelId: "initial" },
      {
        id: "target-channel",
        type: "value",
        valueType: "string",
        value: "chosen",
      },
    ],
    bindings: [
      {
        source: "target-channel",
        output: "value",
        target: "platform",
        input: "channelId",
      },
    ],
  };
  const task = structuredClone(request);
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected paid call");
  };
  const graph = createWorkflowDataGraph({
    flow,
    request: task,
    signal,
    callLLM: unexpected,
    callJev: unexpected,
  });
  const limits: unknown[] = [];
  const result = await runWorkflowPath(
    "channel",
    flow,
    task,
    graph,
    signal,
    {},
    async (rule) => {
      limits.push(rule);
    },
  );
  expect(result).toEqual(runWorkflow("channel", flow, request, signal));
  expect(result.fallback?.channelId).toBe("chosen");
  expect(limits).toEqual(result.requestLimits);
  expect(request.messages).toHaveLength(1);
});

it("rejects invalid computed limits before reaching the provider", async () => {
  const flow: ChannelWorkflow = {
    entry: "start",
    nodes: [
      { id: "start", type: "start", next: ["limit"] },
      { id: "limit", type: "rateLimit", rule: { rpm: 1 }, next: "provider" },
      { id: "provider", type: "provider" },
      { id: "zero", type: "value", valueType: "integer", value: 0 },
    ],
    bindings: [
      { source: "zero", output: "value", target: "limit", input: "rule.rpm" },
    ],
  };
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected paid call");
  };
  const graph = createWorkflowDataGraph({
    flow,
    request,
    signal,
    callLLM: unexpected,
    callJev: unexpected,
  });
  await expect(
    runWorkflowPath("channel", flow, request, graph, signal),
  ).rejects.toMatchObject({ code: "invalid_workflow" });
});
