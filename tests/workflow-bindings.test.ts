import { it, expect } from "vitest";
import type { ChannelWorkflow } from "@pluhub/contracts/workflow";
import { compileWorkflow, runWorkflow } from "../lib/ai/channel-graph.js";

const signal = new AbortController().signal;
const request = {
  model: "public",
  messages: [{ role: "user" as const, text: "hello" }],
  tools: [],
  stream: false,
  maxTokens: 50,
};

it("fans out a typed value into real limit and budget parameters without changing the saved literals", () => {
  const flow: ChannelWorkflow = {
    entry: "s",
    nodes: [
      { id: "s", type: "start", next: "rate" },
      { id: "rate", type: "rateLimit", rule: { rpm: 60 }, next: "budget" },
      { id: "budget", type: "maxTokens", limit: 1024, next: "call" },
      { id: "call", type: "provider" },
      { id: "limit", type: "value", valueType: "integer", value: 10 },
    ],
    bindings: [
      { source: "limit", output: "value", target: "rate", input: "rule.rpm" },
      { source: "limit", output: "value", target: "rate", input: "rule.tpm" },
      { source: "limit", output: "value", target: "budget", input: "limit" },
    ],
  };
  const result = runWorkflow("channel", flow, request, signal);
  expect(result.requestLimits?.[0]?.rule).toEqual({ rpm: 10, tpm: 10 });
  expect(result.request.maxTokens).toBe(10);
  expect((flow.nodes[1] as any).rule).toEqual({ rpm: 60 });
  expect((flow.nodes[2] as any).limit).toBe(1024);
  (flow.nodes[4] as any).value = -1;
  expect(() => compileWorkflow(flow)).toThrow();
});

it("rejects incompatible types, duplicate inputs, cycles and request-derived sensitive values", () => {
  const flow: ChannelWorkflow = {
    entry: "s",
    nodes: [
      { id: "s", type: "start", next: "budget" },
      { id: "budget", type: "maxTokens", limit: 1024, next: "call" },
      { id: "call", type: "provider" },
      { id: "a", type: "value", valueType: "integer", value: 10 },
      { id: "b", type: "value", valueType: "integer", value: 20 },
      { id: "text", type: "value", valueType: "string", value: "oops" },
    ],
    bindings: [
      { source: "a", output: "value", target: "budget", input: "limit" },
    ],
  };
  expect(() =>
    compileWorkflow({
      ...flow,
      bindings: [
        { source: "text", output: "value", target: "budget", input: "limit" },
      ],
    }),
  ).toThrow(/类型/);
  expect(() =>
    compileWorkflow({
      ...flow,
      bindings: [
        ...flow.bindings!,
        { source: "b", output: "value", target: "budget", input: "limit" },
      ],
    }),
  ).toThrow(/一个数据来源/);
  expect(() =>
    compileWorkflow({
      ...flow,
      bindings: [
        { source: "a", output: "value", target: "b", input: "value" },
        { source: "b", output: "value", target: "a", input: "value" },
      ],
    }),
  ).toThrow(/循环/);
  expect(() =>
    compileWorkflow({
      ...flow,
      bindings: [
        { source: "s", output: "textLength", target: "a", input: "value" },
        { source: "a", output: "value", target: "budget", input: "limit" },
      ],
    }),
  ).toThrow(/静态输入/);
});

it("uses resolved personal interfaces and fallback group while retaining the owner's connection", () => {
  const flow: ChannelWorkflow = {
    entry: "s",
    nodes: [
      { id: "s", type: "start", next: "call" },
      { id: "call", type: "provider", fallback: "backup" },
      { id: "backup", type: "platform", groupId: "old" },
      { id: "path", type: "value", valueType: "string", value: "/v1/selected" },
      { id: "group", type: "value", valueType: "string", value: "new" },
    ],
    bindings: [
      {
        source: "path",
        output: "value",
        target: "call",
        input: "interfaces.0.path",
      },
      { source: "group", output: "value", target: "backup", input: "groupId" },
    ],
  };
  const interfaces = [
    {
      incoming: ["openai-chat" as const],
      protocol: "openai-chat" as const,
      path: "/v1/original",
    },
  ];
  const result = runWorkflow("personal", flow, request, signal, {
    personal: true,
    personalInterfaces: interfaces,
  });
  expect(result.providerNode?.interfaces?.[0]?.path).toBe("/v1/selected");
  expect(result.fallback?.groupId).toBe("new");
  expect(interfaces[0]?.path).toBe("/v1/original");
  expect(result.providerNode?.upstream).toBeUndefined();
});
