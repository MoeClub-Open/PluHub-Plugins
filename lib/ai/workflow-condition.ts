import type { WorkflowNode } from "@pluhub/contracts/workflow";
import { modelPatternMatches } from "./model-pattern.js";

type Compare = Extract<WorkflowNode, { type: "compare" }>;
type Logic = Extract<WorkflowNode, { type: "logic" }>;

export function evaluateCompare(node: Compare): boolean {
  const { left, right, operator } = node;
  switch (operator) {
    case "eq":
      return left === right;
    case "ne":
      return left !== right;
    case "matches":
      return (
        typeof left === "string" &&
        Array.isArray(right) &&
        right.some((pattern) => modelPatternMatches(pattern, left))
      );
    case "gt":
      return (
        typeof left === "number" && typeof right === "number" && left > right
      );
    case "gte":
      return (
        typeof left === "number" && typeof right === "number" && left >= right
      );
    case "lt":
      return (
        typeof left === "number" && typeof right === "number" && left < right
      );
    case "lte":
      return (
        typeof left === "number" && typeof right === "number" && left <= right
      );
  }
}

export function evaluateLogic(node: Logic): boolean {
  if (node.operator === "not") return !node.left;
  return node.operator === "and"
    ? node.left && !!node.right
    : node.left || !!node.right;
}
