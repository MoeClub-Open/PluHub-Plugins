import type { Upstream, ProviderConnection } from "@pluhub/contracts/ai";
import type { ChannelWorkflow } from "@pluhub/contracts/workflow";
import { resolveWorkflowStatic } from "./channel-graph.js";
import type { WorkflowNode } from "@pluhub/contracts/workflow";
import { HostError } from "@pluhub/sdk";

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

export function channelProviderNodes(channel: Upstream) {
  const nodes = channel.flow?.bindings?.length
    ? resolveWorkflowStatic(channel.flow).nodes
    : (channel.flow ?? defaultChannelFlow()).nodes;
  return nodes.flatMap((node) => {
    if (node.type !== "provider") return [];
    const connection =
      node.upstream ??
      (channel.protocol && channel.protocol !== "auto-router"
        ? (channel as ProviderConnection)
        : undefined);
    return connection ? [{ id: node.id, connection, node }] : [];
  });
}

export function providerModel(
  node: Extract<WorkflowNode, { type: "provider" }>,
  model: string,
) {
  if (!node.modelMap) return node.model ?? model;
  if (!Object.hasOwn(node.modelMap, model))
    throw new HostError("model_not_found", "上游节点未提供该模型", 400);
  return node.modelMap[model]!;
}
