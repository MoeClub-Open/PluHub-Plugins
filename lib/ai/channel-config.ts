import type { Upstream, ProviderConnection } from "@pluhub/contracts/ai";
import type { ChannelWorkflow } from "@pluhub/contracts/workflow";

export const defaultChannelFlow = (): ChannelWorkflow => ({
  entry: "start",
  nodes: [
    { id: "start", type: "start", next: "provider" },
    { id: "provider", type: "provider" },
  ],
});

export function channelConnections(channel: Upstream): ProviderConnection[] {
  const nested =
    channel.flow?.nodes.flatMap((node) =>
      node.type === "provider" && node.upstream ? [node.upstream] : [],
    ) ?? [];
  if (channel.protocol && channel.protocol !== "auto-router")
    nested.push(channel as ProviderConnection);
  return nested;
}
