import type { Host } from "@pluhub/sdk";
import { HostError } from "@pluhub/sdk";
import type { Upstream } from "@pluhub/contracts/ai";
import type { SubscriptionModel } from "../../lib/ai/subscription-models.js";
import { channelProviderNodes } from "../../lib/ai/channel-config.js";
import type { ProviderConnection } from "@pluhub/contracts/ai";
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
  return {
    nodeId: selected.id,
    ...(await providerModelDirectory(host, connection, signal)),
  };
}

async function providerModelDirectory(
  host: Host,
  connection: ProviderConnection,
  signal: AbortSignal,
) {
  try {
    if (!Object.hasOwn(subscriptionDefaults, connection.protocol))
      return {
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
      models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)),
      errors: [],
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return {
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

/** A provider only declares its own targets; subscription targets must exist in its catalog. */
export async function validateProviderModels(
  host: Host,
  config: { upstreams?: Record<string, Upstream> },
  previous: { upstreams?: Record<string, Upstream> },
  signal: AbortSignal,
) {
  for (const [id, channel] of Object.entries(config.upstreams ?? {})) {
    const prior = previous.upstreams?.[id];
    const previousNodes = prior ? channelProviderNodes(prior) : [];
    for (const node of channel.flow?.nodes ?? []) {
      if (
        node.type !== "provider" ||
        node.modelMap !== undefined ||
        node.model !== undefined ||
        channel.flow?.bindings?.some(
          (binding) =>
            binding.target === node.id &&
            ["model", "modelMap"].includes(binding.input),
        )
      )
        continue;
      const old = previousNodes.find((item) => item.id === node.id);
      if (!old || old.connection.protocol !== node.upstream?.protocol)
        node.modelMap = {};
    }
    for (const selected of channelProviderNodes(channel)) {
      if (!selected.connection.subscriptionAccountIds) continue;
      const old = previousNodes.find((item) => item.id === selected.id);
      const { node, connection } = selected;
      const targets = node.modelMap
        ? Object.values(node.modelMap)
        : node.model
          ? [node.model]
          : [];
      if (
        !targets.length ||
        (old &&
          JSON.stringify([
            old.connection,
            old.node.model,
            old.node.modelMap,
          ]) === JSON.stringify([connection, node.model, node.modelMap]))
      )
        continue;
      const directory = await providerModelDirectory(host, connection, signal);
      if (directory.errors.length)
        throw new HostError(
          "model_directory_unavailable",
          directory.errors.map((error) => error.message).join(" · "),
          502,
        );
      const available = new Set(directory.models.map((model) => model.id));
      const missing = [...new Set(targets)].filter(
        (target) => !available.has(target),
      );
      if (missing.length)
        throw new HostError(
          "model_not_found",
          `上游节点 ${selected.id} 的模型目录中没有：${missing.join("、")}`,
          400,
        );
    }
  }
}
