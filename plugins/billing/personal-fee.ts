import type { RequestPricing } from "@pluhub/contracts/ai";
import { validRate } from "../../lib/commerce/pricing.js";

export function personalRequestPricing(
  config: Record<string, any>,
): RequestPricing {
  return {
    purpose: "personal-fee",
    mode: "request",
    request: config.enabled
      ? validRate(config.personalRequestFee ?? 0, "personal request fee")
      : 0,
    input: 0,
    output: 0,
  };
}
