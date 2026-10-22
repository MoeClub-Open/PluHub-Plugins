import { HostError, type Host, type RequestContext } from "@pluhub/sdk";
import { requireAdminSession } from "./session.js";
export async function requireAdmin(
  host: Host,
  request: Request,
  ctx: RequestContext,
  recent = true,
) {
  requireAdminSession(ctx);
  if (recent && host.hasCapability("auth.admin@1")) {
    const token = /(?:^|;\s*)pluhub_session=([a-zA-Z0-9_-]+)/.exec(
      request.headers.get("cookie") ?? "",
    )?.[1];
    await host.call(
      "auth.admin@1",
      { userId: ctx.principal!.id, token },
      ctx.signal,
    );
  }
}
export function adminTarget(
  ctx: RequestContext,
  userId: string,
  resourceId?: string,
  reason?: string,
) {
  ctx.state.set("admin.userId", userId);
  if (resourceId) ctx.state.set("admin.resourceId", resourceId);
  if (reason) ctx.state.set("admin.reason", reason);
}
export function pageQuery(request: Request) {
  const query = new URL(request.url).searchParams;
  const limit = Number(query.get("limit") ?? 20),
    offset = Number(query.get("offset") ?? 0);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw new HostError("invalid_request", "分页参数无效");
  return {
    query,
    limit,
    offset,
    userId: query.get("userId")?.slice(0, 128),
    q: query.get("q")?.slice(0, 128),
  };
}
