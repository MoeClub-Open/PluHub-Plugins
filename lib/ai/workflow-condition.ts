import { HostError } from "@pluhub/sdk";
import type { AIRequest, Protocol } from "@pluhub/contracts/ai";
import type { WorkflowNode } from "@pluhub/contracts/workflow";
import { modelPatternMatches } from "./model-pattern.js";

type Compare = Extract<WorkflowNode, { type: "compare" }>;
type Logic = Extract<WorkflowNode, { type: "logic" }>;
type Predicate = Extract<WorkflowNode, { type: "predicate" }>;

export function evaluateCompare(node: Compare): boolean {
  const { left, right, operator } = node;
  switch (operator) {
    case "eq": return left === right;
    case "ne": return left !== right;
    case "matches":
      return typeof left === "string" && Array.isArray(right) &&
        right.some((pattern) => modelPatternMatches(pattern, left));
    case "gt": return typeof left === "number" && typeof right === "number" && left > right;
    case "gte": return typeof left === "number" && typeof right === "number" && left >= right;
    case "lt": return typeof left === "number" && typeof right === "number" && left < right;
    case "lte": return typeof left === "number" && typeof right === "number" && left <= right;
  }
}

export function evaluateLogic(node: Logic): boolean {
  if (node.operator === "not") return !node.left;
  return node.operator === "and" ? node.left && !!node.right : node.left || !!node.right;
}

export function evaluatePredicate(
  node: Predicate,
  request: AIRequest,
  context: { ingressProtocol?: Protocol; requestedModel?: string; mappedModel?: string } = {},
): boolean {
  switch (node.test) {
    case "model":
      return (node.models ?? []).some((rule) => modelPatternMatches(rule,
        node.modelSource === "mapped"
          ? (context.mappedModel ?? request.model)
          : (context.requestedModel ?? request.model)));
    case "hasTools": return request.tools.length > 0 || !!request.webSearch;
    case "protocol":
      if (!context.ingressProtocol)
        throw new HostError("ingress_protocol_required", "缺少有效的请求入口协议", 400);
      return context.ingressProtocol === node.protocol;
    case "stream": return request.stream;
    case "textLengthAbove":
      return request.messages.reduce((n, message) => n + message.text.length, 0) > (node.value ?? 0);
  }
}
