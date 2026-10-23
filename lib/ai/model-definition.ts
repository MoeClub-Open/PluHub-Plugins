import { HostError } from "@pluhub/sdk";
import type { ModelDefinition } from "@pluhub/contracts/ai";
import { validateOperations } from "./media.js";
import { validatePricing, validRate } from "../commerce/pricing.js";

/** Shared model metadata for platform and owner-scoped channels. Never copies routing or credential fields. */
export function modelDefinition(input: ModelDefinition): ModelDefinition {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new HostError("invalid_model", "Invalid model definition");
  const result: ModelDefinition = {};
  for (const key of [
    "name",
    "provider",
    "description",
    "contextWindow",
    "operations",
    "reasoningEfforts",
    "inputPrice",
    "outputPrice",
    "pricing",
  ] as const)
    if (input[key] !== undefined)
      Object.assign(result, { [key]: structuredClone(input[key]) });
  for (const key of ["name", "provider", "description"] as const)
    if (result[key] !== undefined && typeof result[key] !== "string")
      throw new HostError("invalid_model", "Invalid model " + key);
  if (
    result.contextWindow !== undefined &&
    (!Number.isSafeInteger(result.contextWindow) || result.contextWindow <= 0)
  )
    throw new HostError("invalid_model", "Invalid model context window");
  validateOperations(result.operations);
  if (
    result.reasoningEfforts !== undefined &&
    (!Array.isArray(result.reasoningEfforts) ||
      result.reasoningEfforts.some(
        (effort) =>
          ![
            "none",
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
          ].includes(effort),
      ))
  )
    throw new HostError("invalid_model", "Invalid reasoning efforts");
  if (result.inputPrice !== undefined) validRate(result.inputPrice);
  if (result.outputPrice !== undefined) validRate(result.outputPrice);
  if (result.pricing !== undefined) {
    if (
      !result.pricing ||
      typeof result.pricing !== "object" ||
      Array.isArray(result.pricing)
    )
      throw new HostError("invalid_model", "Invalid model pricing");
    result.pricing = Object.fromEntries(
      [
        "mode",
        "expression",
        "request",
        "webSearch",
        "cacheRead",
        "cacheWrite",
        "cacheWrite1h",
        "tiers",
      ]
        .filter((key) => Object.hasOwn(result.pricing!, key))
        .map((key) => [key, (result.pricing as any)[key]]),
    );
    validatePricing({
      ...result.pricing,
      input: result.inputPrice ?? 0,
      output: result.outputPrice ?? 0,
    });
  }
  return result;
}
