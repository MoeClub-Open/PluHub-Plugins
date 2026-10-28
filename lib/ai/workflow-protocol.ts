import { HostError } from "@pluhub/sdk";
import type { Protocol } from "@pluhub/contracts/ai";
import type { WorkflowResult } from "@pluhub/contracts/workflow";

export const ingressProtocols: readonly Protocol[] = [
  "openai-chat",
  "openai-responses",
  "anthropic",
  "gemini",
];
export function requireIngressProtocol(value: unknown): Protocol {
  if (!ingressProtocols.includes(value as Protocol))
    throw new HostError(
      "ingress_protocol_required",
      "缺少有效的请求入口协议",
      400,
    );
  return value as Protocol;
}
export function checkProtocolConversion(
  ingress: Protocol | undefined,
  provider: string | undefined,
  policy?: WorkflowResult["protocolPolicy"],
) {
  if (policy?.conversion !== "disabled") return;
  const wireProtocol =
    provider === "codex" || provider === "grok"
      ? "openai-responses"
      : provider === "claude-subscription"
        ? "anthropic"
        : provider === "antigravity"
          ? "gemini"
          : provider;
  if (requireIngressProtocol(ingress) !== wireProtocol)
    throw new HostError(
      "protocol_conversion_forbidden",
      "此渠道仅接受与上游相同的协议，请调整入口或渠道协议策略",
      400,
    );
}
