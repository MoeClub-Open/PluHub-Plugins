import { describe, expect, it } from "vitest";
import type { ChannelWorkflow } from "@pluhub/contracts/workflow";
import { resolveWorkflowBindings } from "../lib/ai/workflow-bindings.js";

describe("workflow binding paths", () => {
  it.each(["constructor.prototype.pluhubUnsafe", "__proto__.pluhubUnsafe", "prototype.pluhubUnsafe"])(
    "rejects an unsafe template variable and does not alter object prototypes: %s",
    (name) => {
      const flow: ChannelWorkflow = {
        entry: "start",
        nodes: [
          { id: "start", type: "start", next: ["provider"] },
          { id: "provider", type: "provider" },
          { id: "input", type: "value", valueType: "string", value: "unsafe" },
          { id: "template", type: "template", template: "", values: { [name]: "" } },
        ],
        bindings: [{ source: "input", output: "value", target: "template", input: `values.${name}` }],
      };
      expect(() => resolveWorkflowBindings(flow)).toThrow();
      expect(Object.hasOwn(Object.prototype, "pluhubUnsafe")).toBe(false);
    },
  );

  it("rejects unsafe path segments even when they are not declared by a node", () => {
    const flow: ChannelWorkflow = {
      entry: "start",
      nodes: [
        { id: "start", type: "start", next: ["provider"] },
        { id: "provider", type: "provider" },
        { id: "input", type: "value", valueType: "string", value: "unsafe" },
      ],
      bindings: [{ source: "input", output: "value", target: "provider", input: "constructor.prototype.pluhubUnsafe" }],
    };
    expect(() => resolveWorkflowBindings(flow)).toThrow(/参数路径/);
    expect(Object.hasOwn(Object.prototype, "pluhubUnsafe")).toBe(false);
  });
});
