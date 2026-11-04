import type { Host } from "@pluhub/sdk";

export const workflowCallers = ["official.ai-router"];

/** The router owns which entry points may delegate authenticated execution. */
export function routingContext(host: Host) {
  return host.requestContext({
    callers: ["official.ai-router", "official.auto-router"],
  });
}
