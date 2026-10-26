import type { RequestContext } from "@pluhub/sdk";
import { channelScope } from "./channel-scope.js";
export function catalogScope(request: Request, ctx: RequestContext) {
  const query = new URL(request.url).searchParams;
  const selected = query.get("channel") || undefined;
  const group = query.get("group") || undefined;
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
