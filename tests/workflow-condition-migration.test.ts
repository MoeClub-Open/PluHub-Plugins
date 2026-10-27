import { expect, it } from "vitest";
import type { ChannelWorkflow } from "@pluhub/contracts/workflow";
import { migrateWorkflowConditions } from "@pluhub/contracts/workflow-migration";

it("splits existing conditions without losing links, layout, or saved values", () => {
  const flow: ChannelWorkflow = {
    name: "existing",
    entry: "start",
    nodes: [
      { id: "start", type: "start", next: "check" },
      { id: "check", type: "condition", test: "model", models: ["old-*"], modelSource: "mapped", yes: "yes", no: "no" },
      { id: "yes", type: "provider" },
      { id: "no", type: "provider" },
      { id: "check-predicate", type: "value", valueType: "string[]", value: ["new-*"] },
    ],
    bindings: [{ source: "check-predicate", output: "value", target: "check", input: "models" }],
    layout: { check: { x: 500, y: 200 }, yes: { x: 900, y: 100 } },
  };
  const original = structuredClone(flow);
  const migrated = migrateWorkflowConditions(flow);
  expect(flow).toEqual(original);
  expect(migrated).toMatchObject({ name: "existing", entry: "start" });
  expect(migrated.nodes).toContainEqual({ id: "check", type: "branch", condition: false, yes: "yes", no: "no" });
  expect(migrated.nodes).toContainEqual({ id: "check-predicate-1", type: "predicate", test: "model", models: ["old-*"], modelSource: "mapped" });
  expect(migrated.bindings).toEqual([
    { source: "check-predicate", output: "value", target: "check-predicate-1", input: "models" },
    { source: "check-predicate-1", output: "result", target: "check", input: "condition" },
  ]);
  expect(migrated.layout).toEqual({ check: { x: 500, y: 200 }, "check-predicate-1": { x: 130, y: 200 }, yes: { x: 900, y: 100 } });
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
  expect(migrateWorkflowConditions(flow).layout?.["check-predicate"]).toEqual({ x: -10, y: 340 });
});
