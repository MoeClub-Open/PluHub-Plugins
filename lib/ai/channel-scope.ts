import { HostError } from "@pluhub/sdk";

export function channelScope(
  principal: { attributes?: Record<string, unknown> } | undefined,
  requested?: string,
) {
  const policy = principal?.attributes;
  const channels = policy?.channelIds as string[] | undefined;
  const channelIds = channels?.length ? channels : undefined;
  if (requested && channelIds && !channelIds.includes(requested))
    throw new HostError("channel_forbidden", "渠道不在密钥授权范围内", 403);
  return {
    channelId:
      requested ?? (channelIds?.length === 1 ? channelIds[0] : undefined),
    channelIds,
  };
}
