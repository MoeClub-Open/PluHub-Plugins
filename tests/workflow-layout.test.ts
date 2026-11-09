import { expect, it } from "vitest";
import type { ChannelWorkflow } from "@pluhub/contracts/workflow";
import { workflowNodePositions } from "../lib/ui/channel-graph-operations.js";

it("places data predicates before their consumer and keeps measured nodes apart", () => {
  const flow: ChannelWorkflow = {
    entry: "start",
    nodes: [
      { id: "start", type: "start", next: ["branch"] },
      { id: "branch", type: "branch", condition: false, yes: "yes", no: "no" },
      {
        id: "compare",
        type: "compare",
        valueType: "number",
        operator: "gt",
        left: 0,
        right: 20,
      },
      { id: "yes", type: "provider", upstream: { protocol: "openai-chat" } },
      { id: "no", type: "provider", upstream: { protocol: "openai-chat" } },
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
  const sizes = new Map(
    flow.nodes.map((node) => [
      node.id,
      { width: 310, height: node.id === "yes" ? 620 : 180 },
    ]),
  );
  const positions = workflowNodePositions(flow, sizes);
  expect(positions.get("start")!.x).toBeLessThan(positions.get("compare")!.x);
  expect(positions.get("compare")!.x).toBeLessThan(positions.get("branch")!.x);
  const yes = positions.get("yes")!,
    no = positions.get("no")!;
  expect(yes.y + 620 <= no.y || no.y + 180 <= yes.y).toBe(true);
  const edited = { ...flow, layout: Object.fromEntries(positions) };
  edited.layout.yes = { x: 30, y: 1500 };
  expect(workflowNodePositions(edited).get("yes")).toEqual({ x: 30, y: 1500 });
});
