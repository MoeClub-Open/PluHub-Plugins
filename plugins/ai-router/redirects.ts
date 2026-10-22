import { HostError } from "@pluhub/sdk";
import type { ModelRedirect } from "@pluhub/contracts/ai";

export function redirectModel(
  model: string,
  rules: Record<string, ModelRedirect>,
) {
  const path: string[] = [model];
  let explicit = false;
  while (Object.hasOwn(rules, model) && rules[model]!.enabled !== false) {
    const rule = rules[model]!;
    model = rule.target;
    explicit ||= rule.mode === "explicit";
    if (path.includes(model) || path.length >= 32)
      throw new HostError(
        "routing_cycle",
        "Model redirect contains a cycle or exceeds 32 hops",
      );
    path.push(model);
  }
  return { model, path, explicit };
}
