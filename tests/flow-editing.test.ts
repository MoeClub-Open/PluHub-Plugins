import { it, expect } from "vitest";
import type { ChannelWorkflow } from "@pluhub/contracts/workflow";
import {
  copyFlowSelection,
  pasteFlowSelection,
  removeFlowNodes,
  comparisonInputNode,
} from "../lib/ui/channel-graph-operations.js";
import { runWorkflow } from "../lib/ai/channel-graph.js";
import { canBindWorkflowPorts } from "../lib/ai/workflow-parameters.js";

const flow: ChannelWorkflow = {
  entry: "start",
  nodes: [
    { id: "start", type: "start", next: ["prompt"] },
    { id: "prompt", type: "prompt", text: "policy", next: "call" },
    { id: "call", type: "provider" },
  ],
  layout: {
    start: { x: 0, y: 0 },
    prompt: { x: 400, y: 0 },
    call: { x: 800, y: 100 },
  },
};

it("connects task length to a numeric comparison and branches on its boolean output", () => {
  const start = { id: "start", type: "start", next: ["branch"] } as const;
  const compare = comparisonInputNode(
    {
      id: "compare",
      type: "compare",
      valueType: "string",
      operator: "matches",
      left: "",
      right: ["old"],
    },
    "integer",
    "left",
    [],
  );
  expect(compare).toMatchObject({
    valueType: "number",
    operator: "eq",
    left: 0,
    right: 0,
  });
  expect(canBindWorkflowPorts(start, "textLength", compare, "left")).toBe(true);
  if (compare.type !== "compare") throw Error("Expected comparison");
  compare.operator = "gt";
  compare.right = 5;
  const graph: ChannelWorkflow = {
    entry: "start",
    nodes: [
      start,
      compare,
      {
        id: "branch",
        type: "branch",
        condition: false,
        yes: "long",
        no: "short",
      },
      { id: "long", type: "provider" },
      { id: "short", type: "provider" },
    ],
    bindings: [
      {
        source: "start",
        output: "textLength",
        target: "compare",
        input: "left",
      },
      {
        source: "compare",
        output: "result",
        target: "branch",
        input: "condition",
      },
    ],
  };
  const run = (text: string) =>
    runWorkflow(
      "test",
      graph,
      {
        model: "model",
        stream: false,
        tools: [],
        messages: [{ role: "user", text }],
      },
      new AbortController().signal,
    ).providerId;
  expect(run("hello")).toBe("short");
  expect(run("longer")).toBe("long");
  expect(comparisonInputNode(compare, "string", "right", graph.bindings!)).toBe(
    compare,
  );
});

it("copies a subgraph with only internal edges and never attaches it to the old path", () => {
  const selection = copyFlowSelection(flow, ["start", "prompt", "call"]);
  const result = pasteFlowSelection(flow, selection, { x: 600, y: 400 })!;
  expect(result.ids).toEqual(["prompt1", "provider"]);
  expect(result.flow.nodes.slice(0, 3)).toEqual(flow.nodes);
  expect(result.flow.nodes[3]).toMatchObject({
    id: "prompt1",
    next: "provider",
  });
  expect(result.flow.layout?.provider).toEqual({ x: 1000, y: 500 });
  const single = copyFlowSelection(flow, ["prompt"]);
  expect(single.nodes[0]).toMatchObject({ next: "" });
});

it("deletes a selection without bypassing removed policy nodes or removing the entry", () => {
  const next = removeFlowNodes(flow, ["start", "prompt"]);
  expect(next.nodes).toEqual([
    { id: "start", type: "start", next: [] },
    { id: "call", type: "provider" },
  ]);
  expect(next.layout?.prompt).toBeUndefined();
});

it("copies only data links inside the selected subgraph and remaps their node IDs", () => {
  const input: ChannelWorkflow = {
    ...flow,
    nodes: [
      ...flow.nodes,
      { id: "config", type: "value", valueType: "string", value: "example" },
    ],
    bindings: [
      { source: "config", output: "value", target: "prompt", input: "text" },
      { source: "config", output: "value", target: "call", input: "model" },
    ],
  };
  expect(copyFlowSelection(input, ["prompt"]).bindings).toEqual([]);
  const selection = copyFlowSelection(input, ["config", "prompt", "call"]);
  const pasted = pasteFlowSelection(input, selection, { x: 200, y: 300 })!;
  expect(pasted.flow.bindings).toEqual([
    ...input.bindings!,
    { source: "value", output: "value", target: "prompt1", input: "text" },
    { source: "value", output: "value", target: "provider", input: "model" },
  ]);
});

it("removes data links attached to deleted nodes while preserving other bindings", () => {
  const input: ChannelWorkflow = {
    ...flow,
    nodes: [
      ...flow.nodes,
      { id: "config", type: "value", valueType: "string", value: "example" },
    ],
    bindings: [
      { source: "config", output: "value", target: "prompt", input: "text" },
      { source: "config", output: "value", target: "call", input: "model" },
    ],
  };
  expect(removeFlowNodes(input, ["prompt"]).bindings).toEqual([
    input.bindings![1],
  ]);
  expect(removeFlowNodes(input, ["config"]).bindings).toEqual([]);
});
