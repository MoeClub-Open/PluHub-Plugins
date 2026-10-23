import { HostError } from "@pluhub/sdk";

export function tokenPrice(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1_000_000
  )
    throw new HostError(
      "invalid_price",
      "价格必须是 0 到 1000000 的有限数字（USD / 百万 Token）",
    );
  return value;
}
export function newApiPrices(
  raw: any,
): Record<string, { inputPrice: number; outputPrice: number }> {
  if (raw?.success === false)
    throw new HostError("pricing_unavailable", "上游未公开倍率配置", 502);
  const data = raw?.data ?? raw;
  if (
    !data ||
    typeof data.model_ratio !== "object" ||
    !data.model_ratio ||
    Array.isArray(data.model_ratio)
  )
    throw new HostError("pricing_unavailable", "上游未提供有效的模型倍率", 502);
  const result: Record<string, { inputPrice: number; outputPrice: number }> =
    Object.create(null);
  for (const [id, ratio] of Object.entries(data.model_ratio).slice(0, 10000)) {
    const completion = data.completion_ratio?.[id];
    // Per-request, cache and other special pricing cannot be represented by a token pair.
    if (
      data.model_price?.[id] !== undefined ||
      typeof ratio !== "number" ||
      typeof completion !== "number"
    )
      continue;
    const inputPrice = tokenPrice(ratio * 2)!;
    const outputPrice = tokenPrice(inputPrice * completion)!;
    result[id] = { inputPrice, outputPrice };
  }
  return result;
}
