import { expect, it } from "vitest";
import type { Host } from "@pluhub/sdk";
import { planRoute } from "../plugins/ai-router/planning.js";
import {
  changeWorkflowConnection,
  removeFlowNodes,
} from "../lib/ui/channel-graph-operations.js";
import { migrateWorkflowConditions } from "@pluhub/contracts/workflow-migration";
import type { ChannelWorkflow } from "@pluhub/contracts/workflow";
import { runWorkflow } from "../lib/ai/channel-graph.js";

it("matches provider models and keeps the selected provider across conversation turns", async () => {
  const connection = {
    protocol: "openai-chat",
    baseUrl: "https://example.com/v1",
    keyRef: "secret:TEST_KEY",
  };
  const config = {
    upstreams: {
      multi: {
        flow: {
          entry: "start",
          nodes: [
            { id: "start", type: "start", next: ["a", "b", "other"] },
            {
              id: "a",
              type: "provider",
              upstream: connection,
              modelMap: { alpha: "vendor-a" },
            },
            {
              id: "b",
              type: "provider",
              upstream: connection,
              modelMap: { alpha: "vendor-b" },
            },
            {
              id: "other",
              type: "provider",
              upstream: connection,
              modelMap: { beta: "vendor-other" },
            },
          ],
        },
      },
    },
    models: {
      assistant: {
        upstream: "multi",
        model: "alpha",
        inputPrice: 1,
        outputPrice: 2,
      },
      other: {
        upstream: "multi",
        model: "beta",
        inputPrice: 1,
        outputPrice: 2,
      },
      unmatched: {
        upstream: "multi",
        model: "gamma",
        inputPrice: 1,
        outputPrice: 2,
      },
    },
  };
  const host = {
    config: () => config,
    hasCapability: (name: string) => name === "ai.upstream.openai-chat@1",
    call: () => {
      throw Error("Selection must not call an upstream");
    },
  } as unknown as Host;
  const messages = [
    { role: "user" as const, text: "first" },
    { role: "assistant" as const, text: "answer" },
    { role: "user" as const, text: "next" },
  ];
  const route = (model: string, sessionId?: string, history = messages) =>
    planRoute(
      host,
      {
        model,
        principalId: "multi-provider-owner",
        ingressProtocol: "openai-chat",
        request: {
          model,
          messages: history,
          stream: false,
          tools: [],
          ...(sessionId ? { sessionId } : {}),
        },
      },
      new AbortController().signal,
    );
  const first = await route("assistant", "conversation");
  const second = await route("assistant", "conversation", [
    ...messages,
    { role: "assistant", text: "answer two" },
    { role: "user", text: "another turn" },
  ]);
  expect(["vendor-a", "vendor-b"]).toContain(first.model);
  expect(second.model).toBe(first.model);
  expect(first.preparedRequest?.messages).toEqual(messages);
  expect((await route("other", "conversation")).model).toBe("vendor-other");
  await expect(route("unmatched", "conversation")).rejects.toMatchObject({
    code: "model_not_found",
  });
  expect(
    new Set([
      (await route("assistant")).model,
      (await route("assistant")).model,
    ]).size,
  ).toBe(2);
});

it("respects a request branch when filtering the connected provider paths", () => {
  const flow: ChannelWorkflow = {
    entry: "start",
    nodes: [
      { id: "start", type: "start", next: ["branch", "b"] },
      { id: "branch", type: "branch", condition: false, yes: "a", no: "other" },
      { id: "condition", type: "value", valueType: "boolean", value: false },
      { id: "a", type: "provider", modelMap: { alpha: "vendor-a" } },
      { id: "b", type: "provider", modelMap: { alpha: "vendor-b" } },
      { id: "other", type: "provider", modelMap: { beta: "vendor-other" } },
    ],
    bindings: [
      {
        source: "condition",
        output: "value",
        target: "branch",
        input: "condition",
      },
    ],
  };
  expect(
    runWorkflow(
      "multi",
      flow,
      { model: "alpha", messages: [], tools: [], stream: false },
      new AbortController().signal,
    ).providerId,
  ).toBe("b");
});

it("migrates the old entry and disconnects one provider without removing its siblings", () => {
  const flow = migrateWorkflowConditions({
    entry: "start",
    nodes: [
      { id: "start", type: "start", next: "a" },
      { id: "a", type: "provider" },
      { id: "b", type: "provider" },
    ],
  });
  const entry = changeWorkflowConnection(
    flow.nodes[0]!,
    "next",
    undefined,
    "b",
  );
  expect(entry).toMatchObject({ next: ["a", "b"] });
  expect(changeWorkflowConnection(entry, "next", "a")).toMatchObject({
    next: ["b"],
  });
  expect(
    removeFlowNodes({ ...flow, nodes: [entry, ...flow.nodes.slice(1)] }, ["a"])
      .nodes[0],
  ).toMatchObject({ next: ["b"] });
});
