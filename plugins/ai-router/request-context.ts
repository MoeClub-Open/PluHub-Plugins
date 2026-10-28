import type { Host } from "@pluhub/sdk";

export const workflowCallers = [
  "official.ai-router",
  "official.ingress-openai-chat",
  "official.ingress-openai-responses",
  "official.ingress-anthropic",
  "official.ingress-gemini",
];

/** The router owns which entry points may delegate authenticated execution. */
export function routingContext(host: Host) {
  return host.requestContext({
    callers: [
      ...workflowCallers,
      "official.auto-router",
      "official.ingress-openai-media",
    ],
  });
}
