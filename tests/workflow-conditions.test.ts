import { describe, expect, it } from "vitest";
import type { AIRequest } from "@pluhub/contracts/ai";
import type { ChannelWorkflow } from "@pluhub/contracts/workflow";
import { compileWorkflow, runWorkflow } from "../lib/ai/channel-graph.js";

const signal = new AbortController().signal;
const request: AIRequest = {
  model: "claude-sonnet",
  messages: [{ role: "user", text: "hello" }],
  tools: [],
  stream: false,
};

describe("workflow conditions", () => {
  it("requires a separate boolean input for a branch", () => {
    const flow: ChannelWorkflow = {
      entry: "start",
      nodes: [
        { id: "start", type: "start", next: ["branch"] },
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

  it("evaluates start outputs for tools, stream, text length, protocol and mapped model", () => {
    const lengthFlow: ChannelWorkflow = {
      entry: "start",
      nodes: [
        { id: "start", type: "start", next: ["prompt"] },
        { id: "prompt", type: "prompt", text: "system prompt", next: "choose" },
        { id: "choose", type: "branch", condition: false, yes: "yes", no: "no" },
        { id: "cmp", type: "compare", valueType: "number", operator: "gt", left: 0, right: 10 },
        { id: "yes", type: "provider" },
        { id: "no", type: "provider" },
      ],
      bindings: [
        { source: "start", output: "textLength", target: "cmp", input: "left" },
        { source: "cmp", output: "result", target: "choose", input: "condition" },
      ],
    };
    expect(runWorkflow("channel", lengthFlow, request, signal).providerId).toBe("yes");

    const mappedFlow: ChannelWorkflow = {
      entry: "start",
      nodes: [
        { id: "start", type: "start", next: ["choose"] },
        { id: "choose", type: "branch", condition: false, yes: "yes", no: "no" },
        { id: "cmp", type: "compare", valueType: "string", operator: "matches", left: "", right: ["provider-*"] },
        { id: "yes", type: "provider" },
        { id: "no", type: "provider" },
      ],
      bindings: [
        { source: "start", output: "mappedModel", target: "cmp", input: "left" },
        { source: "cmp", output: "result", target: "choose", input: "condition" },
      ],
    };
    expect(runWorkflow("channel", mappedFlow, request, signal, { mappedModel: "provider-v1" }).providerId).toBe("yes");
    expect(runWorkflow("channel", mappedFlow, request, signal, { mappedModel: "other" }).providerId).toBe("no");
  });

  it("composes typed comparison and boolean logic separately from branching", () => {
    const flow: ChannelWorkflow = {
      entry: "start",
      nodes: [
        { id: "start", type: "start", next: ["branch"] },
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

  it("does not evaluate an unreachable conditional branch", () => {
    const flow: ChannelWorkflow = {
      entry: "start",
      nodes: [
        { id: "start", type: "start", next: ["first"] },
        { id: "first", type: "branch", condition: false, yes: "yes", no: "second" },
        { id: "second", type: "branch", condition: false, yes: "yes", no: "no" },
        { id: "proto", type: "compare", valueType: "string", operator: "eq", left: "", right: "anthropic" },
        { id: "yes", type: "provider" },
        { id: "no", type: "provider" },
      ],
      bindings: [
        { source: "start", output: "stream", target: "first", input: "condition" },
        { source: "start", output: "ingressProtocol", target: "proto", input: "left" },
        { source: "proto", output: "result", target: "second", input: "condition" },
      ],
    };
    expect(runWorkflow("channel", flow, { ...request, stream: true }, signal).providerId).toBe("yes");
  });

  it("restricts dynamic redirect targets to the configured allowed models", () => {
    const flow: ChannelWorkflow = {
      entry: "start",
      nodes: [
        { id: "start", type: "start", next: ["redirect"] },
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
        { id: "start", type: "start", next: ["redirect"] },
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
        { id: "start", type: "start", next: ["call"] },
        { id: "call", type: "provider" },
        { id: "check", type: "compare", valueType: "boolean", operator: "eq", left: false, right: true },
        { id: "not", type: "logic", operator: "not", left: false },
      ],
      bindings: [
        { source: "start", output: "stream", target: "check", input: "left" },
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
