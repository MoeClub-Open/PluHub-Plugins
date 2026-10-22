import { HostError, type RequestContext } from "@pluhub/sdk";

/** Session authorization without a dependency on a particular authentication provider. */
export function requireAdminSession(ctx: RequestContext) {
  if (!ctx.principal?.session || !ctx.principal.permissions.includes("*"))
    throw new HostError("forbidden", "需要管理员登录会话", 403);
}
