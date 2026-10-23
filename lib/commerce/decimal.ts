import { HostError } from "@pluhub/sdk";

/** Convert a displayed USD amount to ledger micros without floating-point rounding. */
export function usdToMicros(input: string): number {
  const value = input.trim().replace(/^(-?)\./, (_match, sign) => sign + "0.");
  if (!/^-?\d{1,10}(?:\.\d{1,6})?$/.test(value))
    throw new Error("请输入有效的 USD 金额，最多保留六位小数。");
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  const micros =
    (BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, "0"))) *
    (negative ? -1n : 1n);
  if (
    micros > BigInt(Number.MAX_SAFE_INTEGER) ||
    micros < BigInt(Number.MIN_SAFE_INTEGER)
  )
    throw new Error("金额超出可处理范围。");
  return Number(micros);
}

export type Decimal = { n: bigint; d: bigint };
function fraction(n: bigint, d: bigint): Decimal {
  if (!d)
    throw new HostError(
      "invalid_price",
      "Division by zero in billing expression",
    );
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  let a = n < 0n ? -n : n,
    b = d;
  while (b) [a, b] = [b, a % b];
  return { n: n / a, d: d / a };
}
export function decimal(value: number): Decimal {
  if (!Number.isFinite(value))
    throw new HostError("invalid_price", "Non-finite billing value");
  const [mantissa, exponent = "0"] = value.toString().split("e");
  const [whole, digits = ""] = mantissa!.split(".");
  const scale = digits.length - Number(exponent),
    n = BigInt(whole! + digits);
  return scale >= 0
    ? fraction(n, 10n ** BigInt(scale))
    : fraction(n * 10n ** BigInt(-scale), 1n);
}
export const add = (a: Decimal, b: Decimal) =>
  fraction(a.n * b.d + b.n * a.d, a.d * b.d);
export const subtract = (a: Decimal, b: Decimal) =>
  fraction(a.n * b.d - b.n * a.d, a.d * b.d);
export const multiply = (a: Decimal, b: Decimal) =>
  fraction(a.n * b.n, a.d * b.d);
export const divide = (a: Decimal, b: Decimal) =>
  fraction(a.n * b.d, a.d * b.n);
export const compare = (a: Decimal, b: Decimal) => {
  const value = a.n * b.d - b.n * a.d;
  return value < 0n ? -1 : value > 0n ? 1 : 0;
};
export const minimum = (a: Decimal, b: Decimal) => (compare(a, b) <= 0 ? a : b);
export const maximum = (a: Decimal, b: Decimal) => (compare(a, b) >= 0 ? a : b);
export const floor = (a: Decimal): Decimal => ({
  n: a.n / a.d - (a.n < 0n && a.n % a.d ? 1n : 0n),
  d: 1n,
});
export const ceil = (a: Decimal): Decimal => ({
  n: a.n / a.d + (a.n > 0n && a.n % a.d ? 1n : 0n),
  d: 1n,
});
export const numeric = (a: Decimal) => Number(a.n) / Number(a.d);
/** One upward rounding, at the final micro-USD boundary. */
export function rounded(value: Decimal): number {
  if (value.n < 0n)
    throw new HostError(
      "invalid_amount",
      "Billing expression returned a negative amount",
    );
  const amount = ceil(value).n;
  if (amount > BigInt(Number.MAX_SAFE_INTEGER))
    throw new HostError(
      "invalid_amount",
      "Cost exceeds supported integer range",
    );
  return Number(amount);
}
