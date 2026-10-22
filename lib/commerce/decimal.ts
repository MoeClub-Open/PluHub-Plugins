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
