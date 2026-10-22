import { HostError } from "@pluhub/sdk";
import type {
  RequestPricing,
  Usage,
  ModelRoute,
  Upstream,
  TokenPrices,
} from "@pluhub/contracts/ai";

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
  for (const key of rateKeys) {
    if (key === "input" || key === "output" || price[key] !== undefined)
      validRate(price[key], key);
  }
  if (price.mode !== undefined && !["tokens", "request"].includes(price.mode))
    throw new HostError("invalid_price", "Invalid billing mode");
  if (price.mode === "request" || price.request !== undefined)
    validRate(price.request, "request price");
  if (price.multiplier !== undefined)
    validRate(price.multiplier, "multiplier", 1000);
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
    route.pricing?.mode !== "request" &&
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
// Decimal numbers become exact fractions before money is summed or multiplied.
// Round upward only once, at the final micro-USD boundary.
type Decimal = { n: bigint; d: bigint };
function decimal(value: number): Decimal {
  const [mantissa, exponent = "0"] = value.toString().split("e");
  const [whole, fraction = ""] = mantissa!.split(".");
  const scale = fraction.length - Number(exponent);
  const n = BigInt(whole! + fraction);
  return scale >= 0
    ? { n, d: 10n ** BigInt(scale) }
    : { n: n * 10n ** BigInt(-scale), d: 1n };
}
const add = (a: Decimal, b: Decimal): Decimal => ({
  n: a.n * b.d + b.n * a.d,
  d: a.d * b.d,
});
const multiply = (a: Decimal, b: Decimal): Decimal => ({
  n: a.n * b.n,
  d: a.d * b.d,
});
function rounded(value: Decimal): number {
  const n = (value.n + value.d - 1n) / value.d;
  if (n > BigInt(Number.MAX_SAFE_INTEGER))
    throw new HostError(
      "invalid_amount",
      "Cost exceeds supported integer range",
    );
  return Number(n);
}
export interface PriceReceipt {
  amount: number;
  originalAmount: number;
  mode: "tokens" | "request";
  tierAbove?: number;
  usage: Usage;
  pricing: RequestPricing;
  lines: { kind: string; quantity: number; rate: number }[];
}
export function priceUsage(
  usage: Usage,
  pricing: RequestPricing,
): PriceReceipt {
  return calculateUsage(usage, pricing);
}

/** Only persisted pre-migration snapshots may contain retired pricing factors. */
export function priceSnapshotUsage(
  usage: Usage,
  pricing: RequestPricing,
): PriceReceipt {
  const legacy = pricing as RequestPricing & {
    groupMultiplier?: number;
    userMultiplier?: number;
  };
  const factors = [legacy.groupMultiplier, legacy.userMultiplier]
    .filter((factor): factor is number => factor !== undefined)
    .map((factor) => validRate(factor, "historical multiplier", 1000));
  return calculateUsage(usage, pricing, factors);
}

function calculateUsage(
  usage: Usage,
  pricing: RequestPricing,
  historicalFactors: number[] = [],
): PriceReceipt {
  validatePricing(pricing);
  validateUsage(usage);
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
      ? [{ kind: "request", quantity: 1, rate: pricing.request! }]
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
  const originalAmount = rounded(total);
  for (const factor of [pricing.multiplier ?? 1, ...historicalFactors])
    total = multiply(total, decimal(factor));
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
): number {
  validatePricing(pricing);
  if (pricing.mode === "request")
    return priceUsage({ input: 0, output: 0 }, pricing).amount;
  const tiers = [
    pricing,
    ...(pricing.tiers ?? []).map((tier) => ({ ...pricing, ...tier })),
  ];
  return priceUsage(
    { input, output },
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
