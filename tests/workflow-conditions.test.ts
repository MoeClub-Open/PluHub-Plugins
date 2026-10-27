import { describe, expect, it } from "vitest";
import type { AIRequest } from "@pluhub/contracts/ai";
import type { ChannelWorkflow, WorkflowNode } from "@pluhub/contracts/workflow";
import { compileWorkflow, runWorkflow } from "../lib/ai/channel-graph.js";
import { migrateWorkflowConditions } from "@pluhub/contracts/workflow-migration";

const signal = new AbortController().signal;
const request: AIRequest = {
  model: "claude-sonnet",
  messages: [{ role: "user", text: "hello" }],
  tools: [],
  stream: false,
};

function legacyFlow(condition: Extract<WorkflowNode, { type: "condition" }>): ChannelWorkflow {
  return {
    entry: "start",
    nodes: [
      { id: "start", type: "start", next: condition.id },
      condition,
      { id: "yes", type: "provider" },
      { id: "no", type: "provider" },
    ],
  };
}

describe("workflow conditions", () => {
  it("requires a separate boolean input for a branch", () => {
    const flow: ChannelWorkflow = {
      entry: "start",
      nodes: [
        { id: "start", type: "start", next: "branch" },
        { id: "branch", type: "branch", condition: false, yes: "yes", no: "no" },
        { id: "yes", type: "provider" },
        { id: "no", type: "provider" },
        { id: "flag", type: "value", valueType: "boolean", value: true },
      ],
    };
    expect(() => compileWorkflow(flow)).toThrow(/连接布尔条件/);
    flow.bindings = [{ source: "flag", output: "value", target: "branch", input: "condition" }];
    expect(runWorkflow("channel", flow, request, signal).providerId).toBe("yes");
  });

  it.each([
    [{ test: "hasTools" }, { ...request, webSearch: { type: "web_search", options: {} } }, {}],
    [{ test: "stream" }, { ...request, stream: true }, {}],
    [{ test: "textLengthAbove", value: 4 }, request, {}],
    [{ test: "protocol", protocol: "anthropic" }, request, { ingressProtocol: "anthropic" }],
    [{ test: "model", models: ["provider-*"], modelSource: "mapped" }, request, { mappedModel: "provider-v1" }],
  ] as const)("preserves an existing %s condition after splitting it", (settings, input, context) => {
    const flow = legacyFlow({ id: "choose", type: "condition", ...settings, yes: "yes", no: "no" });
    const migrated = migrateWorkflowConditions(flow);
    expect(migrated.nodes.find((node) => node.id === "choose")).toEqual({
      id: "choose", type: "branch", condition: false, yes: "yes", no: "no",
    });
    expect(migrated.nodes.find((node) => node.id === "choose-predicate")?.type).toBe("predicate");
    expect(migrated.bindings).toContainEqual({
      source: "choose-predicate", output: "result", target: "choose", input: "condition",
    });
    expect(migrateWorkflowConditions(migrated)).toBe(migrated);
    expect(runWorkflow("channel", flow, input as AIRequest, signal, context).providerId).toBe("yes");
  });

  it.each([
    [{ test: "hasTools" }, {}],
    [{ test: "stream" }, {}],
    [{ test: "textLengthAbove", value: 5 }, {}],
    [{ test: "protocol", protocol: "anthropic" }, { ingressProtocol: "openai-chat" }],
    [{ test: "model", models: ["provider-*"], modelSource: "mapped" }, { mappedModel: "other" }],
  ] as const)("preserves the false branch of a migrated %s condition", (settings, context) => {
    const flow = legacyFlow({ id: "choose", type: "condition", ...settings, yes: "yes", no: "no" });
    expect(runWorkflow("channel", flow, request, signal, context).providerId).toBe("no");
  });

  it("migrates linked parameters and layout without changing the original or colliding IDs", () => {
    const flow = legacyFlow({ id: "choose", type: "condition", test: "textLengthAbove", value: 0, yes: "yes", no: "no" });
    flow.nodes.push(
      { id: "limit", type: "value", valueType: "integer", value: 10 },
      { id: "choose-predicate", type: "value", valueType: "boolean", value: true },
    );
    flow.bindings = [{ source: "limit", output: "value", target: "choose", input: "value" }];
    flow.layout = { choose: { x: 500, y: 100 } };
    const migrated = migrateWorkflowConditions(flow);
    expect(migrated.bindings).toContainEqual({
      source: "limit", output: "value", target: "choose-predicate-1", input: "value",
    });
    expect(migrated.layout?.["choose-predicate-1"]).toEqual({ x: 130, y: 100 });
    expect(flow.bindings[0]?.target).toBe("choose");
    expect(runWorkflow("channel", migrated, request, signal).providerId).toBe("no");
    expect(runWorkflow("channel", migrated, { ...request, messages: [{ role: "user", text: "longer than ten" }] }, signal).providerId).toBe("yes");
  });

  it("retains a linked condition type and model patterns when migrating", () => {
    const flow = legacyFlow({ id: "choose", type: "condition", test: "stream", models: ["unused"], yes: "yes", no: "no" });
    flow.nodes.push(
      { id: "kind", type: "value", valueType: "string", value: "model" },
      { id: "patterns", type: "value", valueType: "string[]", value: ["claude-*"] },
    );
    flow.bindings = [
      { source: "kind", output: "value", target: "choose", input: "test" },
      { source: "patterns", output: "value", target: "choose", input: "models" },
    ];
    const migrated = migrateWorkflowConditions(flow);
    expect(runWorkflow("channel", migrated, request, signal).providerId).toBe("yes");
    expect(runWorkflow("channel", migrated, { ...request, model: "other" }, signal).providerId).toBe("no");
  });

  it("composes typed comparison and boolean logic separately from branching", () => {
    const flow: ChannelWorkflow = {
      entry: "start",
      nodes: [
        { id: "start", type: "start", next: "branch" },
        { id: "branch", type: "branch", condition: false, yes: "yes", no: "no" },
        { id: "yes", type: "provider" },
        { id: "no", type: "provider" },
        { id: "model", type: "compare", valueType: "string", operator: "matches", left: "", right: ["claude-*"] },
        { id: "both", type: "logic", operator: "and", left: false, right: false },
      ],
      bindings: [
        { source: "start", output: "requestedModel", target: "model", input: "left" },
        { source: "start", output: "stream", target: "both", input: "right" },
        { source: "model", output: "result", target: "both", input: "left" },
        { source: "both", output: "result", target: "branch", input: "condition" },
      ],
    };
    expect(runWorkflow("channel", flow, { ...request, stream: true }, signal).providerId).toBe("yes");
    expect(runWorkflow("channel", flow, { ...request, stream: false }, signal).providerId).toBe("no");
    expect(runWorkflow("channel", flow, { ...request, model: "other", stream: true }, signal).providerId).toBe("no");
  });

  it("evaluates legacy request conditions after preceding request transformations", () => {
    const flow = legacyFlow({ id: "choose", type: "condition", test: "textLengthAbove", value: 10, yes: "yes", no: "no" });
    flow.nodes[0] = { id: "start", type: "start", next: "prompt" };
    flow.nodes.push({ id: "prompt", type: "prompt", text: "system prompt", next: "choose" });
    expect(runWorkflow("channel", flow, request, signal).providerId).toBe("yes");
  });

  it("does not evaluate an unreachable conditional branch", () => {
    const flow: ChannelWorkflow = {
      entry: "start",
      nodes: [
        { id: "start", type: "start", next: "first" },
        { id: "first", type: "condition", test: "stream", yes: "yes", no: "second" },
        { id: "second", type: "condition", test: "protocol", protocol: "anthropic", yes: "yes", no: "no" },
        { id: "yes", type: "provider" },
        { id: "no", type: "provider" },
      ],
    };
    expect(runWorkflow("channel", flow, { ...request, stream: true }, signal).providerId).toBe("yes");
  });

  it("restricts dynamic redirect targets to the configured allowed models", () => {
    const flow: ChannelWorkflow = {
      entry: "start",
      nodes: [
        { id: "start", type: "start", next: "redirect" },
        { id: "redirect", type: "upstream", target: "default", allowedTargets: ["claude-sonnet"], mode: "implicit" },
      ],
      bindings: [{ source: "start", output: "requestedModel", target: "redirect", input: "target" }],
    };
    expect(runWorkflow("channel", flow, request, signal).target).toBe("claude-sonnet");
    expect(() => runWorkflow("channel", flow, { ...request, model: "not-allowed" }, signal)).toThrow(/允许列表/);
    const withoutList = structuredClone(flow);
    const redirect = withoutList.nodes[1];
    if (redirect?.type === "upstream") delete redirect.allowedTargets;
    expect(() => compileWorkflow(withoutList)).toThrow(/允许列表/);
  });

  it("allows a controlled constant to supply the dynamic redirect allowlist", () => {
    const flow: ChannelWorkflow = {
      entry: "start",
      nodes: [
        { id: "start", type: "start", next: "redirect" },
        { id: "redirect", type: "upstream", target: "default", mode: "implicit" },
        { id: "allowed", type: "value", valueType: "string[]", value: ["claude-sonnet"] },
      ],
      bindings: [
        { source: "start", output: "requestedModel", target: "redirect", input: "target" },
        { source: "allowed", output: "value", target: "redirect", input: "allowedTargets" },
      ],
    };
    expect(runWorkflow("channel", flow, request, signal).target).toBe("claude-sonnet");
    expect(() => runWorkflow("channel", flow, { ...request, model: "other" }, signal)).toThrow(/允许列表/);
  });

  it("rejects invalid comparisons, mismatched inputs and dynamic sensitive settings", () => {
    const flow: ChannelWorkflow = {
      entry: "start",
      nodes: [
        { id: "start", type: "start", next: "call" },
        { id: "call", type: "provider" },
        { id: "check", type: "predicate", test: "stream" },
        { id: "not", type: "logic", operator: "not", left: false },
      ],
      bindings: [
        { source: "check", output: "result", target: "not", input: "left" },
        { source: "not", output: "result", target: "call", input: "recordResponseModel" },
      ],
    };
    expect(() => compileWorkflow(flow)).toThrow(/静态输入/);
    expect(() => compileWorkflow({
      ...flow,
      nodes: [...flow.nodes, { id: "bad", type: "compare", valueType: "boolean", operator: "gt", left: false, right: true }],
      bindings: [],
    })).toThrow(/比较条件/);
    expect(() => compileWorkflow({
      ...flow,
      bindings: [{ source: "start", output: "requestedModel", target: "not", input: "left" }],
    })).toThrow(/类型/);
  });
});
