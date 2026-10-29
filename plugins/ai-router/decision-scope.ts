import { routingContext } from "./request-context.js";
import { randomUUID } from "node:crypto";
import { HostError, type Host, type RequestContext } from "@pluhub/sdk";
import type { AIPlan, AIRequest } from "@pluhub/contracts/ai";

export interface DecisionScope {
  profile: string;
  request: AIRequest;
  entryModel: string;
  channelId?: string;
  allowedChannelIds?: readonly string[];
  requestLimits?: AIPlan["requestLimits"];
  principalId?: string;
}

// A token is scoped to the actual host context and consumed exactly once.
// It never lives in ctx.state or in client-controlled request data.
const scopes = new WeakMap<RequestContext, Map<string, DecisionScope>>();

export async function withDecisionScope<T>(
  host: Host,
  scope: DecisionScope,
  invoke: (token?: string) => Promise<T>,
): Promise<T> {
  let context: RequestContext;
  try {
    context = routingContext(host);
  } catch {
    // Management previews are not gateway requests. Rules still work there;
    // a remote decision cannot retrieve a scope or create a child request.
    return invoke();
  }
  const entry = context.state.get("ai.request") as AIRequest | undefined;
  const fallback = (context.state.get("ai.plan") as AIPlan | undefined)
    ?.fallback;
  const isFallback =
    context.state.get("ai.executionRejected") === true &&
    fallback?.model === scope.entryModel &&
    fallback.principalId === scope.principalId &&
    fallback.channelId === scope.channelId;
  if (
    !context.principal ||
    context.principal.id !== scope.principalId ||
    !entry ||
    (entry.model !== scope.entryModel && !isFallback)
  )
    throw new HostError("forbidden", "无权发起流程决策", 403);
  const token = randomUUID();
  const active = scopes.get(context) ?? new Map<string, DecisionScope>();
  scopes.set(context, active);
  active.set(token, structuredClone(scope));
  try {
    return await invoke(token);
  } finally {
    active.delete(token);
    if (!active.size && scopes.get(context) === active) scopes.delete(context);
  }
}

/** Retrieve and consume the scope for this context, profile and one-time token. */
export function getDecisionScope(
  host: Host,
  profile: string,
  token: unknown,
): DecisionScope {
  const context = routingContext(host);
  const active = scopes.get(context);
  const entry = typeof token === "string" ? active?.get(token) : undefined;
  if (
    !entry ||
    entry.profile !== profile ||
    context.principal?.id !== entry.principalId
  )
    throw new HostError("forbidden", "无效或已使用的流程决策授权", 403);
  active!.delete(token as string);
  if (!active!.size && scopes.get(context) === active) scopes.delete(context);
  return entry;
}
