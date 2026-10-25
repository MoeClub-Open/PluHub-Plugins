import type { RequestContext } from "@pluhub/sdk";
import { channelScope } from "./channel-scope.js";
export function catalogScope(request: Request, ctx: RequestContext) {
  const selected =
    new URL(request.url).searchParams.get("channel") || undefined;
  const group = new URL(request.url).searchParams.get("group") || undefined;
  return {
    personalOnly: group === "personal" && !!ctx.principal?.session,
    principalId: ctx.principal?.id,
    includePersonal: !!ctx.principal?.session,
    ...channelScope(
      ctx.principal,
      selected,
      group === "personal" ? undefined : group,
    ),
  };
}
