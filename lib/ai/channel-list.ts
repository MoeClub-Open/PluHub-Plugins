import type { Upstream, ModelRoute } from "@pluhub/contracts/ai";
import { channelConnections } from "./channel-config.js";

export function filterChannels(
  upstreams: Record<string, Upstream>,
  models: Record<string, ModelRoute>,
  query: string,
  status: string,
  protocol: string,
) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return Object.entries(upstreams).filter(([id, channel]) => {
    if (status === "enabled" && channel.enabled === false) return false;
    if (status === "disabled" && channel.enabled !== false) return false;
    if (
      protocol &&
      !channelConnections(channel).some((u) => u.protocol === protocol) &&
      channel.protocol !== protocol
    )
      return false;
    const routes = Object.entries(models).filter(
      ([, model]) => model.upstream === id,
    );
    const text = [
      id,
      channel.name,
      channel.protocol,
      channel.baseUrl,
      ...channelConnections(channel).flatMap((u) => [u.protocol, u.baseUrl]),
      ...routes.flatMap(([alias, model]) => [alias, model.name, model.model]),
    ]
      .join(" ")
      .toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export function setChannelState(
  upstreams: Record<string, Upstream>,
  ids: string[],
  enabled: boolean,
) {
  // Validate the complete selection before mutating, so stale selections cannot
  // result in a partially updated configuration.
  if (!ids.length || ids.some((id) => !Object.hasOwn(upstreams, id)))
    throw new Error("所选渠道已变化，请刷新后重新选择。");
  for (const id of ids) upstreams[id]!.enabled = enabled;
}

export function syncChannelSecrets(
  plugins: { path: string; config?: Record<string, unknown> }[],
  previous: Record<string, Upstream>,
  next: Record<string, Upstream>,
  protocols: string[],
) {
  const refs = (channels: Record<string, Upstream>, protocol: string) =>
    new Set(
      Object.values(channels)
        .flatMap(channelConnections)
        .filter((channel) => channel.protocol === protocol)
        .map((channel) => channel.keyRef)
        .filter((ref): ref is string => !!ref),
    );
  for (const protocol of protocols) {
    const before = refs(previous, protocol),
      after = refs(next, protocol);
    if (
      before.size === after.size &&
      [...before].every((ref) => after.has(ref))
    )
      continue;
    for (const plugin of plugins) {
      if (
        !new RegExp("/(?:official\\.)?upstream-" + protocol + "$").test(
          plugin.path.replaceAll("\\", "/"),
        )
      )
        continue;
      const existing = (plugin.config?.secretRefs ?? []) as string[];
      plugin.config = {
        ...plugin.config,
        secretRefs: [
          ...new Set([
            ...existing.filter((ref) => !before.has(ref) || after.has(ref)),
            ...after,
          ]),
        ],
      };
    }
  }
}
