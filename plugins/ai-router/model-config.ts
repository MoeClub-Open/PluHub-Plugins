import type { ModelRoute } from "@pluhub/contracts/ai";
import type { ChannelModel } from "./channel-models.js";

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
