import { it, expect } from "vitest";
import type { ChannelWorkflow } from "@pluhub/contracts/workflow";
import {
  copyFlowSelection,
  pasteFlowSelection,
  removeFlowNodes,
} from "../lib/ui/channel-graph-operations.js";

const flow: ChannelWorkflow = {
  entry: "start",
  nodes: [
    { id: "start", type: "start", next: "prompt" },
    { id: "prompt", type: "prompt", text: "policy", next: "call" },
    { id: "call", type: "provider" },
  ],
  layout: {
    start: { x: 0, y: 0 },
    prompt: { x: 400, y: 0 },
    call: { x: 800, y: 100 },
  },
};

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
    { id: "start", type: "start", next: "" },
    { id: "call", type: "provider" },
  ]);
  expect(next.layout?.prompt).toBeUndefined();
});
