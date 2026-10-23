import type {
  PricingContext,
  PricingScalar,
  RequestPricing,
  Usage,
} from "@pluhub/contracts/ai";
import {
  asNode,
  compileExpression,
  contextKeyAllowed,
  fail,
  functionName,
  stringLiteral,
  type Leaf,
  type Node,
} from "./expression-program.js";
import {
  bound,
  evaluate,
  evaluateAmount,
  point,
  truth,
  unknown,
  type Environment,
} from "./expression-eval.js";
import {
  add,
  decimal,
  divide,
  maximum,
  minimum,
  multiply,
  numeric,
  type Decimal,
} from "./decimal.js";

const scalar = (value: unknown): PricingScalar =>
  value === null ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value)) ||
  (typeof value === "string" && value.length <= 512)
    ? (value as PricingScalar)
    : null;
export function capturePricingContext(
  params: unknown,
  headers = new Headers(),
  at = Date.now(),
): PricingContext {
  const context: PricingContext = { at, params: {}, headers: {} };
  function walk(value: unknown, path: string, depth = 0) {
    if (depth > 8 || (path && !contextKeyAllowed(path, false))) return;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, item] of Object.entries(value))
        walk(item, path ? path + "." + key : key, depth + 1);
    } else if (path) context.params[path] = scalar(value);
  }
  walk(params, "");
  for (const [key, value] of headers)
    if (contextKeyAllowed(key, true)) context.headers[key] = scalar(value);
  return context;
}
export function bindPricingContext(
  pricing: RequestPricing,
  facts: PricingContext,
): RequestPricing {
  if (pricing.mode !== "expression") return pricing;
  if (
    !Number.isSafeInteger(facts.at) ||
    !Number.isFinite(new Date(facts.at).getTime())
  )
    return fail("Invalid billing timestamp");
  const program = compileExpression(pricing.expression!);
  return {
    ...pricing,
    context: {
      at: facts.at,
      params: Object.fromEntries(
        [...program.params].map((key) => [key, scalar(facts.params[key])]),
      ),
      headers: Object.fromEntries(
        [...program.headers].map((key) => [key, scalar(facts.headers[key])]),
      ),
    },
  };
}
/** Persist only scalar facts explicitly referenced by this pricing program. */
export function freezePricing(
  pricing: RequestPricing,
  at: number,
  params: unknown = {},
  headers = new Headers(),
): RequestPricing {
  return pricing.mode === "expression"
    ? bindPricingContext(pricing, capturePricingContext(params, headers, at))
    : pricing;
}
const isFixed = (leaf: Leaf) => {
  const value = asNode(leaf.arguments[1]!);
  return value.type === "CallExpression" && functionName(value) === "fixed";
};
export function fixedPricing(pricing: RequestPricing) {
  if (pricing.mode === "request") return true;
  if (pricing.mode !== "expression") return false;
  const program = compileExpression(pricing.expression!);
  return !program.variables.size && program.leaves.every(isFixed);
}
function environment(
  used: Set<string>,
  usage: Usage,
  context: PricingContext,
  reserve: boolean,
): Environment {
  const cr = usage.cacheRead ?? 0,
    cc = usage.cacheWrite ?? 0,
    hour = usage.cacheWrite1h ?? 0,
    r = usage.reasoning ?? 0;
  const counts: Record<string, number> = {
    p:
      usage.input -
      (used.has("cr") ? cr : 0) -
      (used.has("cc") ? cc : used.has("cc1h") ? hour : 0),
    c: usage.output - (used.has("r") ? r : 0),
    len: usage.input,
    cr,
    cc: cc - (used.has("cc1h") ? hour : 0),
    cc1h: hour,
    r,
  };
  const variables = Object.fromEntries(
    Object.entries(counts).map(([key, value]) => [
      key,
      reserve
        ? bound(0, ["c", "r"].includes(key) ? usage.output : usage.input)
        : point(value),
    ]),
  );
  variables.total = {
    lo: add(variables.len!.lo, reserve ? decimal(0) : point(usage.output).lo),
    hi: add(variables.len!.hi, point(usage.output).hi),
  };
  return { variables, context };
}
function selected(node: Node, env: Environment): Leaf[] {
  if (node.type !== "ConditionalExpression") return [node as Leaf];
  const result = truth(evaluate(asNode(node.test), env));
  return result === unknown
    ? [
        ...selected(asNode(node.consequent), env),
        ...selected(asNode(node.alternate), env),
      ]
    : selected(asNode(result ? node.consequent : node.alternate), env);
}
function leafAmount(leaf: Leaf, factors: Node[], env: Environment): Decimal {
  const value = asNode(leaf.arguments[1]!);
  const fixed = multiply(
    decimal(isFixed(leaf) ? Number((value as Leaf).arguments[0]!.value) : 0),
    decimal(1_000_000),
  );
  let amount = isFixed(leaf)
    ? { lo: fixed, hi: fixed }
    : evaluateAmount(value, env);
  for (const factor of factors) {
    const rate = evaluateAmount(factor, env);
    const values = [
      multiply(amount.lo, rate.lo),
      multiply(amount.lo, rate.hi),
      multiply(amount.hi, rate.lo),
      multiply(amount.hi, rate.hi),
    ];
    amount = { lo: values.reduce(minimum), hi: values.reduce(maximum) };
  }
  return amount.hi;
}
export function expressionCost(
  usage: Usage,
  pricing: RequestPricing,
  reserve = false,
) {
  const program = compileExpression(pricing.expression!);
  if (!pricing.context)
    return fail("Billing request context has not been frozen");
  const guards = environment(new Set(), usage, pricing.context, reserve),
    leaves = selected(program.tree, guards);
  const results = leaves.map((leaf) => {
    const env = environment(
      program.leafVariables.get(leaf)!,
      usage,
      pricing.context!,
      reserve,
    );
    return {
      leaf,
      env,
      amount: leafAmount(leaf, program.factors.get(leaf)!, env),
    };
  });
  const amount = results.map((result) => result.amount).reduce(maximum),
    { leaf, env } = results[0]!;
  return {
    amount,
    tier: stringLiteral(leaf.arguments[0]),
    mode: isFixed(leaf) ? ("request" as const) : ("tokens" as const),
    variables: Object.fromEntries(
      [...program.variables].map((key) => [
        key,
        numeric(env.variables[key]!.hi),
      ]),
    ),
  };
}
export function formatNode(node: Node): string {
  switch (node.type) {
    case "Literal":
      return JSON.stringify(node.value);
    case "Identifier":
      return node.name;
    case "UnaryExpression":
      return node.operator + "(" + formatNode(asNode(node.argument)) + ")";
    case "BinaryExpression":
      return (
        "(" +
        formatNode(asNode(node.left)) +
        " " +
        node.operator +
        " " +
        formatNode(asNode(node.right)) +
        ")"
      );
    case "ConditionalExpression":
      return (
        "(" +
        formatNode(asNode(node.test)) +
        " ? " +
        formatNode(asNode(node.consequent)) +
        " : " +
        formatNode(asNode(node.alternate)) +
        ")"
      );
    case "CallExpression":
      return (
        functionName(node) +
        "(" +
        node.arguments.map((arg) => formatNode(asNode(arg))).join(", ") +
        ")"
      );
    default:
      return fail("Unsupported pricing display");
  }
}
/** Structured token rows are projections of the expression, never a second price source. */
export function expressionRules(source: string) {
  const program = compileExpression(source);
  const rules: {
    name: string;
    condition: string;
    formula: string;
    mode: "tokens" | "request";
    rates?: Record<string, number>;
    request?: number;
  }[] = [];
  function walk(node: Node, conditions: string[]) {
    if (node.type === "ConditionalExpression") {
      const test = formatNode(asNode(node.test));
      walk(asNode(node.consequent), [...conditions, test]);
      walk(asNode(node.alternate), [...conditions, "!(" + test + ")"]);
      return;
    }
    const leaf = node as Leaf,
      body = asNode(leaf.arguments[1]!);
    const rule: (typeof rules)[number] = {
      name: stringLiteral(leaf.arguments[0]),
      condition: conditions.join(" && "),
      formula: formatNode(body),
      mode: isFixed(leaf) ? "request" : "tokens",
    };
    const factors = program.factors.get(leaf)!;
    if (factors.length)
      rule.formula =
        "(" +
        rule.formula +
        ") * " +
        factors.map((factor) => "(" + formatNode(factor) + ")").join(" * ");
    else if (isFixed(leaf))
      rule.request = Number((body as Leaf).arguments[0]!.value);
    else if (!factors.length) {
      function linear(node: Node): Record<string, number> | undefined {
        if (node.type === "BinaryExpression" && node.operator === "+") {
          const a = linear(asNode(node.left)),
            b = linear(asNode(node.right));
          if (!a || !b) return;
          for (const [key, value] of Object.entries(b))
            a[key] = (a[key] ?? 0) + value;
          return a;
        }
        if (node.type === "BinaryExpression" && node.operator === "*") {
          const a = asNode(node.left),
            b = asNode(node.right);
          if (
            a.type === "Identifier" &&
            b.type === "Literal" &&
            typeof b.value === "number"
          )
            return { [a.name]: b.value };
          if (
            b.type === "Identifier" &&
            a.type === "Literal" &&
            typeof a.value === "number"
          )
            return { [b.name]: a.value };
        }
        if (node.type === "Literal" && node.value === 0) return {};
      }
      rule.rates = linear(body);
    }
    rules.push(rule);
  }
  walk(program.tree, []);
  return rules;
}
export const expressionDollars = (amount: Decimal) =>
  numeric(divide(amount, decimal(1_000_000)));
