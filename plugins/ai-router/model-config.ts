import type { ModelRoute, Upstream } from "@pluhub/contracts/ai";
import type { ChannelModel } from "./channel-models.js";
import { defaultChannelFlow } from "../../lib/ai/channel-config.js";

export function assignProviderModel(
  config: {
    upstreams: Record<string, Upstream>;
    models: Record<string, ModelRoute>;
  },
  channelId: string,
  nodeId: string,
  model: string,
  target: string,
) {
  const channel = config.upstreams[channelId]!;
  const flow = (channel.flow ??= defaultChannelFlow());
  const node = flow.nodes.find((item) => item.id === nodeId);
  if (node?.type !== "provider")
    throw new Error("上游节点不存在或尚未配置连接");
  if (
    flow.bindings?.some(
      (binding) =>
        binding.target === nodeId &&
        ["model", "modelMap"].includes(binding.input),
    )
  )
    throw new Error("请先断开上游节点的模型参数连线");
  node.modelMap ??= Object.fromEntries(
    Object.values(config.models)
      .filter((route) => route.upstream === channelId)
      .map((route) => [route.model, node.model ?? route.model]),
  );
  node.modelMap[model] = target;
  delete node.model;
}

export function availableModelId(
  reserved: Iterable<string>,
  channelId: string,
  model: string,
) {
  const used = new Set(reserved);
  const base =
    model.replace(/[^a-zA-Z0-9._/\-]/g, "-").replace(/^[^a-zA-Z0-9]+/, "") ||
    "model";
  if (!used.has(base.slice(0, 128))) return base.slice(0, 128);
  const prefix = channelId.replace(/[^a-zA-Z0-9._\-]/g, "-") + "/";
  let candidate = (prefix + base).slice(0, 128);
  let suffix = 2;
  while (used.has(candidate)) {
    const tail = "-" + suffix++;
    candidate = (prefix + base).slice(0, 128 - tail.length) + tail;
  }
  return candidate;
}

export function discoveredModelRoute(
  channelId: string,
  model: ChannelModel,
): ModelRoute {
  return {
    upstream: channelId,
    model: model.id,
    publicModel: model.id,
    ...(model.name && model.name !== model.id ? { name: model.name } : {}),
    ...(model.contextLength ? { contextWindow: model.contextLength } : {}),
    enabled: false,
  };
}
