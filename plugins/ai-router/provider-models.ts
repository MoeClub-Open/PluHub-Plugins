import type { Host } from "@pluhub/sdk";
import { HostError } from "@pluhub/sdk";
import type { Upstream } from "@pluhub/contracts/ai";
import type { SubscriptionModel } from "../../lib/ai/subscription-models.js";
import { channelProviderNodes } from "../../lib/ai/channel-config.js";
import { discoverConnectionModels } from "../../lib/ai/model-directory.js";
import { subscriptionDefaults } from "../../lib/ai/subscription-auth.js";

/** Discovery always belongs to one provider node; it does not declare a channel's public models. */
export async function readNodeModels(
  host: Host,
  id: string,
  nodeId: string | undefined,
  signal: AbortSignal,
) {
  const channel = (host.config().upstreams as Record<string, Upstream>)[id];
  if (!channel) throw new HostError("not_found", "Channel not found", 404);
  const nodes = channelProviderNodes(channel);
  if (!nodeId && nodes.length > 1)
    throw new HostError("provider_required", "请选择获取模型的上游节点", 400);
  const selected = nodeId ? nodes.find((node) => node.id === nodeId) : nodes[0];
  if (!selected)
    throw new HostError("not_found", "上游节点不存在或尚未配置连接", 404);
  const connection = selected.connection;
  try {
    if (!Object.hasOwn(subscriptionDefaults, connection.protocol))
      return {
        nodeId: selected.id,
        ...(await discoverConnectionModels(host, connection, signal)),
      };
    const ids = connection.subscriptionAccountIds ?? [];
    if (!ids.length)
      throw new HostError("subscription_missing", "尚未选择订阅账号");
    const lists = await Promise.all(
      ids.map((accountId) =>
        host.call<SubscriptionModel[]>(
          `ai.subscription.${connection.protocol}@1`,
          {
            action: "models",
            id: accountId,
            ownerId: "",
            provider: connection.protocol,
          },
          signal,
        ),
      ),
    );
    const models = new Map(
      lists
        .flat()
        .map((model) => [
          model.id,
          { ...model, protocols: [connection.protocol] },
        ]),
    );
    return {
      nodeId: selected.id,
      models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)),
      errors: [],
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      nodeId: selected.id,
      models: [],
      errors: [
        {
          protocol: connection.protocol,
          message: error instanceof Error ? error.message : "模型目录查询失败",
        },
      ],
    };
  }
}
