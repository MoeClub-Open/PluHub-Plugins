import { HostError } from "@pluhub/sdk";

export function channelScope(
  principal: { attributes?: Record<string, unknown> } | undefined,
  requested?: string,
  requestedGroup?: string,
) {
  const policy = principal?.attributes;
  const channels = policy?.channelIds as string[] | undefined;
  const channelIds = channels?.length ? channels : undefined;
  if (requested && channelIds && !channelIds.includes(requested))
    throw new HostError("channel_forbidden", "渠道不在密钥授权范围内", 403);
  const groupId = policy?.groupId as string | undefined;
  if (policy?.keyId && requestedGroup && requestedGroup !== groupId)
    throw new HostError("group_forbidden", "密钥不能切换使用分组", 403);
  return {
    groupId: policy?.keyId ? groupId : requestedGroup,
    channelId:
      requested ?? (channelIds?.length === 1 ? channelIds[0] : undefined),
    channelIds,
  };
}
