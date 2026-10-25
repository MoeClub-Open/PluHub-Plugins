import { HostError } from "@pluhub/sdk";
import type { RequestPricing, ServiceGroup } from "@pluhub/contracts/ai";

export function serviceGroups(
  config: Record<string, any>,
): Record<string, ServiceGroup> {
  return { default: { name: "默认分组", multiplier: 1 }, ...config.groups };
}
export function groupAccess(group: ServiceGroup, userId?: string) {
  return (
    group.enabled !== false &&
    (!group.userIds || (!!userId && group.userIds.includes(userId)))
  );
}
export function resolveGroup(
  config: Record<string, any>,
  id = "default",
  userId?: string,
) {
  const all = serviceGroups(config);
  const group = Object.hasOwn(all, id) ? all[id] : undefined;
  if (!group || !groupAccess(group, userId))
    throw new HostError(
      "group_unavailable",
      "使用分组已停用或无权访问，请检查密钥分组",
      403,
    );
  return {
    id,
    ...group,
    channelIds: group.channelIds ?? Object.keys(config.upstreams ?? {}),
  };
}
export function groupPricing(
  pricing: RequestPricing | undefined,
  group?: ServiceGroup & { id: string },
) {
  if (!pricing || !group) return pricing;
  return {
    ...pricing,
    multiplier: (pricing.multiplier ?? 1) * (group.multiplier ?? 1),
    serviceGroup: {
      id: group.id,
      name: group.name,
      multiplier: group.multiplier ?? 1,
    },
  };
}
