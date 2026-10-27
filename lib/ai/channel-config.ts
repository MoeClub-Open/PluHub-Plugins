import type { Upstream, ProviderConnection } from "@pluhub/contracts/ai";
import type { ChannelWorkflow } from "@pluhub/contracts/workflow";
import { resolveWorkflowStatic } from "./channel-graph.js";

export const defaultChannelFlow = (): ChannelWorkflow => ({
  entry: "start",
  nodes: [
    { id: "start", type: "start", next: "provider" },
    { id: "provider", type: "provider" },
  ],
});

export function channelConnections(channel: Upstream): ProviderConnection[] {
  const nodes = channel.flow?.bindings?.length
    ? resolveWorkflowStatic(
        channel.flow,
        channel.credentialId ? channel.interfaces : undefined,
        !!channel.credentialId,
      ).nodes
    : (channel.flow?.nodes ?? []);
  const nested = nodes.flatMap((node) =>
    node.type === "provider" && node.upstream ? [node.upstream] : [],
  );
  if (channel.protocol && channel.protocol !== "auto-router")
    nested.push(channel as ProviderConnection);
  return nested;
}
