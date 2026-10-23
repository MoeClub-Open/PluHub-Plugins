import type { Upstream, ModelRoute } from "@pluhub/contracts/ai";
import { connectionInterfaces } from "./upstream-interfaces.js";
import { channelConnections } from "./channel-config.js";

export function filterChannels(
  upstreams: Record<string, Upstream>,
  models: Record<string, ModelRoute>,
  query: string,
  status: string,
  protocol: string,
) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return Object.entries(upstreams)
    .filter(([id, channel]) => {
      if (status === "enabled" && channel.enabled === false) return false;
      if (status === "disabled" && channel.enabled !== false) return false;
      if (
        protocol &&
        !channelConnections(channel)
          .flatMap(connectionInterfaces)
          .some((u) => u.protocol === protocol) &&
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
        ...channelConnections(channel)
          .flatMap(connectionInterfaces)
          .flatMap((u) => [u.protocol, u.baseUrl]),
        ...routes.flatMap(([alias, model]) => [alias, model.name, model.model]),
      ]
        .join(" ")
        .toLocaleLowerCase();
      return words.every((word) => text.includes(word));
    })
    .sort(
      ([a, left], [b, right]) =>
        (right.priority ?? 0) - (left.priority ?? 0) ||
        a.localeCompare(b, undefined, { numeric: true }),
    );
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
