import jsep from "jsep";
import { HostError } from "@pluhub/sdk";

export type Node = jsep.CoreExpression;
export type Leaf = jsep.CallExpression;
export const fail = (message: string): never => {
  throw new HostError("invalid_expression", message);
};
const variables = new Set(["p", "c", "len", "cr", "cc", "cc1h", "r", "total"]);
const operators = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "<=",
  ">=",
  "==",
  "!=",
  "===",
  "!==",
  "&&",
  "||",
]);
const math = new Set(["min", "max", "abs", "ceil", "floor", "round"]);
export const clockFunctions = new Set([
  "hour",
  "minute",
  "weekday",
  "month",
  "day",
  "year",
]);
export interface Program {
  tree: Node;
  variables: Set<string>;
  params: Set<string>;
  headers: Set<string>;
  leaves: Leaf[];
  leafVariables: Map<Leaf, Set<string>>;
  factors: Map<Leaf, Node[]>;
}
const cache = new Map<string, Program>();
export function contextKeyAllowed(key: string, header: boolean) {
  return (
    !!key &&
    key.length <= 128 &&
    !/(?:authorization|cookie|api.?key|password|secret|access.?token|refresh.?token)/i.test(
      key,
    ) &&
    (header ||
      (/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/.test(key) &&
        !/(?:^|\.)(?:messages|input|contents|content|prompt|negative_prompt|tools|system|systemInstruction|system_instruction|instructions)(?:\.|$)/i.test(
          key,
        )))
  );
}
export const asNode = (value: jsep.Expression) => value as Node;
export function functionName(node: jsep.CallExpression): string {
  if (node.callee.type !== "Identifier")
    return fail("Only named billing functions are allowed");
  return (node.callee as jsep.Identifier).name;
}
export function stringLiteral(node: jsep.Expression | undefined): string {
  if (
    node?.type !== "Literal" ||
    typeof (node as jsep.Literal).value !== "string"
  )
    return fail("Billing function requires a string literal");
  return (node as jsep.Literal).value as string;
}
export function compileExpression(source: string): Program {
  if (typeof source !== "string" || !source.trim() || source.length > 16384)
    return fail("Billing expression must contain 1–16384 characters");
  const existing = cache.get(source);
  if (existing) return existing;
  let tree: Node;
  try {
    tree = asNode(jsep(source));
  } catch (error) {
    return fail("Invalid billing expression: " + (error as Error).message);
  }
  const program: Program = {
    tree,
    variables: new Set(),
    params: new Set(),
    headers: new Set(),
    leaves: [],
    leafVariables: new Map(),
    factors: new Map(),
  };
  let count = 0;
  type ValueType =
    "number" | "string" | "boolean" | "null" | "unknown" | "mixed";
  const numericType = (kind: ValueType) => {
    if (kind !== "number" && kind !== "unknown")
      return fail("Billing arithmetic requires numeric values");
  };
  function check(node: Node, depth = 0, used?: Set<string>): ValueType {
    if (++count > 1024 || depth > 64)
      return fail("Billing expression is too complex");
    const child = (value: jsep.Expression) =>
      check(asNode(value), depth + 1, used);
    switch (node.type) {
      case "Literal":
        if (typeof node.value === "number" && !Number.isFinite(node.value))
          return fail("Invalid numeric literal");
        if (
          node.value !== null &&
          !["number", "string", "boolean"].includes(typeof node.value)
        )
          return fail("Unsupported billing literal");
        return node.value === null ? "null" : (typeof node.value as ValueType);
      case "Identifier":
        if (!variables.has(node.name))
          return fail("Unknown billing variable: " + node.name);
        program.variables.add(node.name);
        used?.add(node.name);
        return "number";
      case "UnaryExpression":
        if (!["+", "-", "!"].includes(node.operator))
          return fail("Unsupported billing operator");
        if (node.operator === "!") {
          child(node.argument);
          return "boolean";
        }
        numericType(child(node.argument));
        return "number";
      case "BinaryExpression": {
        if (!operators.has(node.operator))
          return fail("Unsupported billing operator: " + node.operator);
        const left = child(node.left),
          right = child(node.right);
        if (["==", "!=", "===", "!==", "&&", "||"].includes(node.operator))
          return "boolean";
        numericType(left);
        numericType(right);
        if (
          ["/", "%"].includes(node.operator) &&
          node.right.type === "Literal" &&
          (node.right as jsep.Literal).value === 0
        )
          return fail("Division by zero in billing expression");
        return ["<", ">", "<=", ">="].includes(node.operator)
          ? "boolean"
          : "number";
      }
      case "ConditionalExpression": {
        child(node.test);
        const yes = child(node.consequent),
          no = child(node.alternate);
        return yes === no
          ? yes
          : [yes, no].every(
                (value) => value === "number" || value === "unknown",
              )
            ? "unknown"
            : "mixed";
      }
      case "CallExpression": {
        const name = functionName(node),
          args = node.arguments;
        if (math.has(name)) {
          if (
            ["min", "max"].includes(name)
              ? args.length < 2 || args.length > 16
              : args.length !== 1
          )
            return fail("Invalid argument count for " + name);
        } else if (name === "has") {
          if (args.length !== 2) return fail("has() requires two arguments");
        } else if (clockFunctions.has(name)) {
          if (args.length !== 1) return fail(name + "() requires one timezone");
          try {
            new Intl.DateTimeFormat("en-US", {
              timeZone: stringLiteral(args[0]),
            }).format(0);
          } catch {
            return fail("Invalid billing timezone");
          }
        } else if (name === "header" || name === "param") {
          if (args.length !== 1)
            return fail(name + "() requires one literal key");
          const key = stringLiteral(args[0]);
          if (!contextKeyAllowed(key, name === "header"))
            return fail("Sensitive or invalid billing context key");
          (name === "header" ? program.headers : program.params).add(
            name === "header" ? key.toLowerCase() : key,
          );
        } else return fail("Unknown billing function: " + name);
        const types = args.map(child);
        if (math.has(name)) types.forEach(numericType);
        return name === "has"
          ? "boolean"
          : name === "header" || name === "param"
            ? "unknown"
            : "number";
      }
      default:
        return fail("Unsupported billing syntax: " + node.type);
    }
  }
  function containsTier(node: Node): boolean {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      (node.callee as jsep.Identifier).name === "tier"
    )
      return true;
    return Object.values(node).some((value) =>
      Array.isArray(value)
        ? value.some(
            (child) =>
              child &&
              typeof child === "object" &&
              "type" in child &&
              containsTier(asNode(child as jsep.Expression)),
          )
        : value &&
          typeof value === "object" &&
          "type" in value &&
          containsTier(asNode(value as jsep.Expression)),
    );
  }
  function pricingTree(node: Node, depth = 0, factors: Node[] = []): Node {
    if (depth > 64) return fail("Billing expression is too complex");
    if (
      node.type === "BinaryExpression" &&
      ["*", "/"].includes(node.operator)
    ) {
      const left = asNode(node.left),
        right = asNode(node.right);
      if (containsTier(left) && !containsTier(right)) {
        const factor: Node =
          node.operator === "*"
            ? right
            : {
                type: "BinaryExpression",
                operator: "/",
                left: { type: "Literal", value: 1, raw: "1" },
                right,
              };
        return pricingTree(left, depth + 1, [...factors, factor]);
      }
      if (node.operator === "*" && !containsTier(left) && containsTier(right))
        return pricingTree(right, depth + 1, [...factors, left]);
    }
    if (node.type === "ConditionalExpression") {
      check(asNode(node.test));
      return {
        ...node,
        consequent: pricingTree(asNode(node.consequent), depth + 1, factors),
        alternate: pricingTree(asNode(node.alternate), depth + 1, factors),
      };
    }
    if (
      node.type !== "CallExpression" ||
      functionName(node) !== "tier" ||
      node.arguments.length !== 2
    )
      return fail("Each pricing branch must be tier(name, price)");
    const label = stringLiteral(node.arguments[0]);
    if (!label || label.length > 128) return fail("Invalid billing tier name");
    const body = asNode(node.arguments[1]!);
    const used = new Set<string>();
    for (const factor of factors) numericType(check(factor, 0, used));
    if (body.type === "CallExpression" && functionName(body) === "fixed") {
      const literal = asNode(body.arguments[0]!);
      if (
        body.arguments.length !== 1 ||
        literal?.type !== "Literal" ||
        typeof literal.value !== "number" ||
        !Number.isFinite(literal.value) ||
        literal.value < 0 ||
        literal.value > 1_000_000
      )
        return fail("fixed() requires a non-negative literal USD price");
      if (used.size)
        return fail(
          "A fixed request price cannot be multiplied by token usage",
        );
    } else numericType(check(body, 0, used));
    program.leafVariables.set(node, used);
    program.factors.set(node, factors);
    program.leaves.push(node);
    return node;
  }
  program.tree = pricingTree(tree);
  if (cache.size >= 256) cache.delete(cache.keys().next().value!);
  cache.set(source, program);
  return program;
}
