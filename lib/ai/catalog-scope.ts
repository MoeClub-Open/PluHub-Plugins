import { HostError, type RequestContext } from "@pluhub/sdk";
export function catalogScope(request: Request, ctx: RequestContext) {
  const bound = ctx.principal?.attributes?.channelId as string | undefined;
  const selected =
    new URL(request.url).searchParams.get("channel") || undefined;
  if (bound && selected && bound !== selected)
    throw new HostError("channel_forbidden", "不能覆盖密钥的渠道绑定", 403);
  return { principalId: ctx.principal?.id, channelId: bound ?? selected };
}
