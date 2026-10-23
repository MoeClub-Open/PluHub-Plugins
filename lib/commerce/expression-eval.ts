import type { PricingContext, PricingScalar } from "@pluhub/contracts/ai";
import {
  asNode,
  clockFunctions,
  fail,
  functionName,
  type Node,
} from "./expression-program.js";
import {
  decimal,
  add,
  subtract,
  multiply,
  divide,
  compare,
  minimum,
  maximum,
  floor,
  ceil,
  type Decimal,
} from "./decimal.js";

export interface Range {
  lo: Decimal;
  hi: Decimal;
}
export const unknown = Symbol("uncertain billing condition");
type Value = Range | Exclude<PricingScalar, number> | typeof unknown;
export const point = (value: number): Range => ({
  lo: decimal(value),
  hi: decimal(value),
});
export const bound = (lo: number, hi: number): Range => ({
  lo: decimal(lo),
  hi: decimal(hi),
});
const zero = decimal(0);
const isRange = (value: Value): value is Range =>
  value !== null && typeof value === "object";
const range = (value: Value): Range =>
  isRange(value) ? value : fail("Billing arithmetic requires numeric values");
const union = (a: Range, b: Range): Range => ({
  lo: minimum(a.lo, b.lo),
  hi: maximum(a.hi, b.hi),
});
const extents = (values: Decimal[]): Range => ({
  lo: values.reduce(minimum),
  hi: values.reduce(maximum),
});
export function truth(value: Value): boolean | typeof unknown {
  if (value === unknown) return unknown;
  if (isRange(value)) {
    if (!compare(value.lo, zero) && !compare(value.hi, zero)) return false;
    return compare(value.lo, zero) > 0 || compare(value.hi, zero) < 0
      ? true
      : unknown;
  }
  return !!value;
}
function equality(a: Value, b: Value): boolean | typeof unknown {
  if (a === unknown || b === unknown) return unknown;
  if (!isRange(a) || !isRange(b)) return a === b;
  if (compare(a.hi, b.lo) < 0 || compare(a.lo, b.hi) > 0) return false;
  return !compare(a.lo, a.hi) && !compare(b.lo, b.hi)
    ? !compare(a.lo, b.lo)
    : unknown;
}
const negate = (value: boolean | typeof unknown) =>
  value === unknown ? unknown : !value;
const clockCache = new Map<string, Intl.DateTimeFormat>();
function clock(name: string, timezone: string, at: number) {
  let format = clockCache.get(timezone);
  if (!format) {
    if (clockCache.size >= 128)
      clockCache.delete(clockCache.keys().next().value!);
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
    });
    clockCache.set(timezone, format);
  }
  const parts = Object.fromEntries(
    format.formatToParts(at).map((part) => [part.type, part.value]),
  );
  return name === "weekday"
    ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday!)
    : Number(parts[name]);
}
export interface Environment {
  variables: Record<string, Range>;
  context: PricingContext;
}
export function evaluate(node: Node, env: Environment): Value {
  switch (node.type) {
    case "Literal":
      return typeof node.value === "number"
        ? point(node.value)
        : (node.value as Exclude<PricingScalar, number>);
    case "Identifier":
      return env.variables[node.name] ?? fail("Missing billing variable");
    case "UnaryExpression": {
      const value = evaluate(asNode(node.argument), env);
      if (node.operator === "!") return negate(truth(value));
      const a = range(value);
      return node.operator === "+"
        ? a
        : { lo: subtract(zero, a.hi), hi: subtract(zero, a.lo) };
    }
    case "BinaryExpression": {
      const a = evaluate(asNode(node.left), env),
        operator = node.operator;
      if (operator === "&&" || operator === "||") {
        const left = truth(a);
        if (operator === "&&" && left === false) return false;
        if (operator === "||" && left === true) return true;
        const right = truth(evaluate(asNode(node.right), env));
        if (operator === "&&")
          return right === false
            ? false
            : left === unknown || right === unknown
              ? unknown
              : true;
        return right === true
          ? true
          : left === unknown || right === unknown
            ? unknown
            : false;
      }
      const b = evaluate(asNode(node.right), env);
      if (["==", "==="].includes(operator)) return equality(a, b);
      if (["!=", "!=="].includes(operator)) return negate(equality(a, b));
      const x = range(a),
        y = range(b);
      if (operator === "+") return { lo: add(x.lo, y.lo), hi: add(x.hi, y.hi) };
      if (operator === "-")
        return { lo: subtract(x.lo, y.hi), hi: subtract(x.hi, y.lo) };
      if (operator === "*")
        return extents([
          multiply(x.lo, y.lo),
          multiply(x.lo, y.hi),
          multiply(x.hi, y.lo),
          multiply(x.hi, y.hi),
        ]);
      if (operator === "/") {
        if (compare(y.lo, zero) <= 0 && compare(y.hi, zero) >= 0)
          return fail("Billing divisor may be zero");
        return extents([
          divide(x.lo, y.lo),
          divide(x.lo, y.hi),
          divide(x.hi, y.lo),
          divide(x.hi, y.hi),
        ]);
      }
      if (operator === "%") {
        if (compare(y.lo, zero) <= 0 && compare(y.hi, zero) >= 0)
          return fail("Billing divisor may be zero");
        if (!compare(x.lo, x.hi) && !compare(y.lo, y.hi)) {
          const quotient = divide(x.lo, y.lo);
          const amount = subtract(
            x.lo,
            multiply({ n: quotient.n / quotient.d, d: 1n }, y.lo),
          );
          return { lo: amount, hi: amount };
        }
        const size = maximum(
          maximum(y.hi, subtract(zero, y.lo)),
          maximum(y.lo, subtract(zero, y.hi)),
        );
        return {
          lo: compare(x.lo, zero) < 0 ? subtract(zero, size) : zero,
          hi: size,
        };
      }
      if (operator === "<")
        return compare(x.hi, y.lo) < 0
          ? true
          : compare(x.lo, y.hi) >= 0
            ? false
            : unknown;
      if (operator === "<=")
        return compare(x.hi, y.lo) <= 0
          ? true
          : compare(x.lo, y.hi) > 0
            ? false
            : unknown;
      if (operator === ">")
        return compare(x.lo, y.hi) > 0
          ? true
          : compare(x.hi, y.lo) <= 0
            ? false
            : unknown;
      if (operator === ">=")
        return compare(x.lo, y.hi) >= 0
          ? true
          : compare(x.hi, y.lo) < 0
            ? false
            : unknown;
      return fail("Unsupported billing operator");
    }
    case "ConditionalExpression": {
      const selected = truth(evaluate(asNode(node.test), env));
      if (selected !== unknown)
        return evaluate(
          asNode(selected ? node.consequent : node.alternate),
          env,
        );
      const yes = evaluate(asNode(node.consequent), env),
        no = evaluate(asNode(node.alternate), env);
      return isRange(yes) && isRange(no)
        ? union(yes, no)
        : equality(yes, no) === true
          ? yes
          : unknown;
    }
    case "CallExpression": {
      const name = functionName(node);
      const args = node.arguments.map((arg) => evaluate(asNode(arg), env));
      if (clockFunctions.has(name))
        return point(clock(name, args[0] as string, env.context.at));
      if (name === "header" || name === "param") {
        const key =
          name === "header"
            ? (args[0] as string).toLowerCase()
            : (args[0] as string);
        const value =
          (name === "header" ? env.context.headers : env.context.params)[key] ??
          null;
        return typeof value === "number" ? point(value) : value;
      }
      if (name === "has")
        return args.includes(unknown)
          ? unknown
          : typeof args[0] === "string" &&
              typeof args[1] === "string" &&
              args[0].includes(args[1]);
      const numbers = args.map(range);
      if (name === "min")
        return {
          lo: numbers.map((v) => v.lo).reduce(minimum),
          hi: numbers.map((v) => v.hi).reduce(minimum),
        };
      if (name === "max")
        return {
          lo: numbers.map((v) => v.lo).reduce(maximum),
          hi: numbers.map((v) => v.hi).reduce(maximum),
        };
      const a = numbers[0]!;
      if (name === "abs") {
        const values = [a.lo, a.hi].map((v) =>
          v.n < 0n ? subtract(zero, v) : v,
        );
        return {
          lo:
            compare(a.lo, zero) <= 0 && compare(a.hi, zero) >= 0
              ? zero
              : values.reduce(minimum),
          hi: values.reduce(maximum),
        };
      }
      const operation =
        name === "ceil"
          ? ceil
          : name === "round"
            ? (value: Decimal) => floor(add(value, decimal(0.5)))
            : floor;
      return { lo: operation(a.lo), hi: operation(a.hi) };
    }
    default:
      return fail("Unsupported billing value");
  }
}
export function evaluateAmount(node: Node, env: Environment): Range {
  return range(evaluate(node, env));
}
