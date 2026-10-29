import { expect, it } from "vitest";
import type { ChannelWorkflow } from "@pluhub/contracts/workflow";
import { migrateWorkflowConditions } from "@pluhub/contracts/workflow-migration";

it("migrates a saved request condition to a comparison with the same result port", () => {
  const migrated = migrateWorkflowConditions({ entry: "start", nodes: [
    { id: "start", type: "start", next: "call" },
    { id: "check", type: "predicate", test: "textLengthAbove", value: 100 },
    { id: "call", type: "provider" },
  ], bindings: [{ source: "check", output: "result", target: "other", input: "left" }] });
  expect(migrated.nodes[1]).toEqual({ id: "check", type: "compare", valueType: "number", operator: "gt", left: 0, right: 100 });
  expect(migrated.bindings).toEqual([
    { source: "check", output: "result", target: "other", input: "left" },
    { source: "start", output: "textLength", target: "check", input: "left" },
  ]);
});

it("splits existing conditions without losing links, layout, or saved values", () => {
  const flow: ChannelWorkflow = {
    name: "existing",
    entry: "start",
    nodes: [
      { id: "start", type: "start", next: "check" },
      { id: "check", type: "condition", test: "model", models: ["old-*"], modelSource: "mapped", yes: "yes", no: "no" },
      { id: "yes", type: "provider" },
      { id: "no", type: "provider" },
      { id: "check-compare", type: "value", valueType: "string[]", value: ["new-*"] },
    ],
    bindings: [{ source: "check-compare", output: "value", target: "check", input: "models" }],
    layout: { check: { x: 500, y: 200 }, yes: { x: 900, y: 100 } },
  };
  const original = structuredClone(flow);
  const migrated = migrateWorkflowConditions(flow);
  expect(flow).toEqual(original);
  expect(migrated).toMatchObject({ name: "existing", entry: "start" });
  expect(migrated.nodes).toContainEqual({ id: "check", type: "branch", condition: false, yes: "yes", no: "no" });
  expect(migrated.nodes).toContainEqual({ id: "check-compare-1", type: "compare", valueType: "string", operator: "matches", left: "", right: ["old-*"] });
  expect(migrated.bindings).toEqual([
    { source: "check-compare", output: "value", target: "check-compare-1", input: "right" },
    { source: "check-compare-1", output: "result", target: "check", input: "condition" },
    { source: "start", output: "mappedModel", target: "check-compare-1", input: "left" },
  ]);
  expect(migrated.layout).toEqual({ check: { x: 500, y: 200 }, "check-compare-1": { x: 130, y: 200 }, yes: { x: 900, y: 100 } });
  expect(migrateWorkflowConditions(migrated)).toEqual(migrated);
});

it("places the separated condition away from an existing node", () => {
  const flow: ChannelWorkflow = {
    entry: "start",
    nodes: [
      { id: "start", type: "start", next: "check" },
      { id: "check", type: "condition", test: "stream", yes: "yes", no: "no" },
      { id: "yes", type: "provider" },
      { id: "no", type: "provider" },
    ],
    layout: { start: { x: 0, y: 80 }, check: { x: 360, y: 80 } },
  };
  expect(migrateWorkflowConditions(flow).layout?.["check-compare"]).toEqual({ x: -10, y: 340 });
});
