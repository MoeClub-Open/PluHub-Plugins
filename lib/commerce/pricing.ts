import { HostError } from "@pluhub/sdk";
import type {
  RequestPricing,
  Usage,
  ModelRoute,
  Upstream,
  TokenPrices,
} from "@pluhub/contracts/ai";
import { decimal, add, multiply, rounded } from "./decimal.js";
import { compileExpression } from "./expression-program.js";
import { expressionCost, expressionDollars } from "./expression.js";

const rateKeys = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "cacheWrite1h",
] as const;
export function validRate(
  value: unknown,
  name = "price",
  maximum = 1_000_000,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > maximum
  )
    throw new HostError("invalid_price", "Invalid " + name);
  return value;
}
export function validatePricing(price: RequestPricing) {
  if (price.webSearch !== undefined)
    validRate(price.webSearch, "web search price");
  for (const key of rateKeys) {
    if (key === "input" || key === "output" || price[key] !== undefined)
      validRate(price[key], key);
  }
  if (
    price.mode !== undefined &&
    !["tokens", "request", "expression"].includes(price.mode)
  )
    throw new HostError("invalid_price", "Invalid billing mode");
  if (price.mode === "expression") {
    compileExpression(price.expression!);
    if (
      price.request !== undefined ||
      price.tiers !== undefined ||
      rateKeys.slice(2).some((key) => price[key] !== undefined)
    )
      throw new HostError(
        "invalid_price",
        "Expression pricing cannot include additional rate tables",
      );
  } else if (price.expression !== undefined)
    throw new HostError(
      "invalid_price",
      "Select expression pricing to use an expression",
    );
  if (price.mode === "request" || price.request !== undefined)
    validRate(price.request, "request price");
  if (price.multiplier !== undefined)
    validRate(price.multiplier, "multiplier", 1_000_000_000);
  let previous = -1;
  if (
    price.tiers !== undefined &&
    (!Array.isArray(price.tiers) || price.tiers.length > 32)
  )
    throw new HostError("invalid_price", "Invalid pricing tiers");
  for (const tier of price.tiers ?? []) {
    if (
      price.mode === "request" ||
      !Number.isSafeInteger(tier.above) ||
      tier.above < 0 ||
      tier.above <= previous
    )
      throw new HostError(
        "invalid_price",
        "Pricing tiers must have strictly increasing input thresholds",
      );
    previous = tier.above;
    for (const key of rateKeys)
      if (key === "input" || key === "output" || tier[key] !== undefined)
        validRate(tier[key], key);
  }
}
export function routePricing(
  route: ModelRoute,
  upstream?: Upstream,
): RequestPricing | undefined {
  if (
    !["request", "expression"].includes(route.pricing?.mode ?? "tokens") &&
    (route.inputPrice === undefined || route.outputPrice === undefined)
  )
    return;
  const price: RequestPricing = {
    ...route.pricing,
    input: route.effectiveInputPrice ?? route.inputPrice ?? 0,
    output: route.effectiveOutputPrice ?? route.outputPrice ?? 0,
    ...(upstream?.consumptionMultiplier !== undefined
      ? { multiplier: upstream.consumptionMultiplier }
      : {}),
  };
  validatePricing(price);
  return price;
}
export function validateUsage(usage: Usage) {
  for (const key of [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "cacheWrite1h",
    "reasoning",
    "webSearch",
  ] as const)
    if (
      (key === "input" || key === "output" || usage[key] !== undefined) &&
      (!Number.isSafeInteger(usage[key]) || Number(usage[key]) < 0)
    )
      throw new HostError("invalid_usage", "Invalid usage " + key, 502);
  if (
    (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) > usage.input ||
    (usage.cacheWrite1h ?? 0) > (usage.cacheWrite ?? 0) ||
    (usage.reasoning ?? 0) > usage.output
  )
    throw new HostError(
      "invalid_usage",
      "Usage detail exceeds its token total",
      502,
    );
}
export interface UsagePriceReceipt {
  amount: number;
  originalAmount: number;
  mode: "tokens" | "request";
  tierAbove?: number;
  tier?: string;
  expression?: string;
  variables?: Record<string, number>;
  usage: Usage;
  pricing: RequestPricing;
  lines: { kind: string; quantity: number; rate: number }[];
}
export interface ReservedPriceReceipt {
  mode: "reserved";
  amount: number;
  pricing?: RequestPricing;
  lines: [];
}
export type PriceReceipt = UsagePriceReceipt | ReservedPriceReceipt;
export function priceUsage(
  usage: Usage,
  pricing: RequestPricing,
): UsagePriceReceipt {
  validatePricing(pricing);
  validateUsage(usage);
  if (pricing.mode === "expression") {
    const result = expressionCost(usage, pricing);
    const original = add(
      result.amount,
      multiply(
        decimal(pricing.webSearch ?? 0),
        decimal((usage.webSearch ?? 0) * 1_000_000),
      ),
    );
    let total = original;
    total = multiply(total, decimal(pricing.multiplier ?? 1));
    return {
      amount: rounded(total),
      originalAmount: rounded(original),
      mode: result.mode,
      tier: result.tier,
      expression: pricing.expression,
      variables: result.variables,
      usage: structuredClone(usage),
      pricing: structuredClone(pricing),
      lines: [
        {
          kind: "expression",
          quantity: 1,
          rate: expressionDollars(result.amount),
        },
        ...(usage.webSearch
          ? [
              {
                kind: "webSearch",
                quantity: usage.webSearch,
                rate: pricing.webSearch ?? 0,
              },
            ]
          : []),
      ],
    };
  }
  let rates: TokenPrices = pricing;
  let tierAbove: number | undefined;
  for (const tier of pricing.tiers ?? [])
    if (usage.input > tier.above) {
      rates = { ...pricing, ...tier };
      tierAbove = tier.above;
    }
  const mode = pricing.mode ?? "tokens";
  const lines =
    mode === "request"
      ? [{ kind: pricing.purpose === "personal-fee" ? "serviceFee" : "request", quantity: 1, rate: pricing.request! }]
      : [
          {
            kind: "input",
            quantity:
              usage.input - (usage.cacheRead ?? 0) - (usage.cacheWrite ?? 0),
            rate: rates.input,
          },
          { kind: "output", quantity: usage.output, rate: rates.output },
          {
            kind: "cacheRead",
            quantity: usage.cacheRead ?? 0,
            rate: rates.cacheRead ?? rates.input,
          },
          {
            kind: "cacheWrite",
            quantity: (usage.cacheWrite ?? 0) - (usage.cacheWrite1h ?? 0),
            rate: rates.cacheWrite ?? rates.input,
          },
          {
            kind: "cacheWrite1h",
            quantity: usage.cacheWrite1h ?? 0,
            rate: rates.cacheWrite1h ?? rates.cacheWrite ?? rates.input,
          },
        ].filter((line) => line.quantity > 0);
  let total = { n: 0n, d: 1n };
  for (const line of lines)
    total = add(
      total,
      multiply(
        decimal(line.rate),
        decimal(line.quantity * (mode === "request" ? 1_000_000 : 1)),
      ),
    );
  if (usage.webSearch) {
    const rate = pricing.webSearch ?? 0;
    total = add(
      total,
      multiply(decimal(rate), decimal(usage.webSearch * 1_000_000)),
    );
    lines.push({ kind: "webSearch", quantity: usage.webSearch, rate });
  }
  const originalAmount = rounded(total);
  total = multiply(total, decimal(pricing.multiplier ?? 1));
  return {
    amount: rounded(total),
    originalAmount,
    mode,
    ...(tierAbove === undefined ? {} : { tierAbove }),
    usage: structuredClone(usage),
    pricing: structuredClone(pricing),
    lines,
  };
}
/** Prepaid bound covers every configured context tier and cache-write premium. */
export function reserveCost(
  input: number,
  output: number,
  pricing: RequestPricing,
  webSearch = 0,
): number {
  validatePricing(pricing);
  if (pricing.mode === "expression")
    return rounded(
      multiply(
        add(
          expressionCost({ input, output }, pricing, true).amount,
          multiply(
            decimal(pricing.webSearch ?? 0),
            decimal(webSearch * 1_000_000),
          ),
        ),
        decimal(pricing.multiplier ?? 1),
      ),
    );
  if (pricing.mode === "request")
    return priceUsage({ input: 0, output: 0, webSearch }, pricing).amount;
  const tiers = [
    pricing,
    ...(pricing.tiers ?? []).map((tier) => ({ ...pricing, ...tier })),
  ];
  return priceUsage(
    { input, output, webSearch },
    {
      ...pricing,
      tiers: undefined,
      input: Math.max(
        ...tiers.flatMap((p) => [
          p.input,
          p.cacheRead ?? p.input,
          p.cacheWrite ?? p.input,
          p.cacheWrite1h ?? p.cacheWrite ?? p.input,
        ]),
      ),
      output: Math.max(...tiers.map((p) => p.output)),
    },
  ).amount;
}
