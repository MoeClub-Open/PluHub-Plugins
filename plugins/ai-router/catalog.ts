import { resolveGroup, groupPricing } from "./groups.js";
import { HostError, type Host } from "@pluhub/sdk";
import type {
  CatalogModel,
  ModelRoute,
  ModelRedirect,
  Upstream,
  PersonalChannel,
} from "@pluhub/contracts/ai";
import { redirectModel } from "./redirects.js";
import { routePricing } from "../../lib/commerce/pricing.js";
import { routeKindForProtocol } from "../../lib/ai/decision-route-kind.js";

export interface CatalogScope {
  principalId?: string;
  channelId?: string;
  channelIds?: readonly string[];
  includePersonal?: boolean;
  personalOnly?: boolean;
  groupId?: string;
  /** Internal routing distinguishes Jev from conversational channels. */
  routeKind?: "chat" | "systemone" | "luna" | "jev";
}

function supportsKind(channel: Upstream, kind: NonNullable<CatalogScope["routeKind"]>) {
  if (!channel.flow)
    return kind === routeKindForProtocol(channel.protocol);
  const flow = channel.flow;
  const nodes = new Map(flow.nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  function visit(id: string): boolean {
    if (!id || seen.has(id)) return false;
    seen.add(id);
    const node = nodes.get(id);
    if (!node) return false;
    if (node.type === "provider") {
      if (flow.bindings?.some((binding) => binding.target === id && binding.input === "upstream.protocol")) return true;
      const protocol = node.upstream?.protocol ?? channel.protocol;
      return (kind === routeKindForProtocol(protocol)) ||
        (!!node.fallback && visit(node.fallback));
    }
    if (node.type === "response") return kind === "chat";
    // Delegated targets are resolved and checked after selection.
    if (node.type === "upstream" || node.type === "routing" || node.type === "platform") return true;
    if (node.type === "branch")
      return visit(node.yes) || visit(node.no);
    return "next" in node ? visit(node.next) : false;
  }
  return visit(flow.entry);
}

function catalog(
  config: Record<string, any>,
  channelId?: string,
  routeKind?: CatalogScope["routeKind"],
): CatalogModel[] {
  const upstreams = (config.upstreams ?? {}) as Record<string, Upstream>;
  const models = { ...(config.models ?? {}) } as Record<string, ModelRoute>;
  const redirects = (config.redirects ?? {}) as Record<string, ModelRedirect>;
  for (const [id, rule] of Object.entries(redirects)) {
    if (rule.enabled === false) continue;
    const target = redirectModel(id, redirects).model;
    if (models[target]) models[id] = { ...models[target]!, publicModel: id };
  }
  return Object.entries(models)
    .filter(
      ([, m]) =>
        (!channelId || m.upstream === channelId) &&
        m.enabled !== false &&
        upstreams[m.upstream] &&
        upstreams[m.upstream]!.enabled !== false &&
        (!routeKind || supportsKind(upstreams[m.upstream]!, routeKind)),
    )
    .map(([id, m]) => ({
      id: m.publicModel ?? id,
      routeId: id,
      channelPriority: upstreams[m.upstream]?.priority ?? 0,
      channelId: m.upstream,
      channel: {
        id: m.upstream,
        name: upstreams[m.upstream]?.name || m.upstream,
        scope: m.upstream.startsWith("personal:") ? "personal" : "platform",
      },
      name: m.name || id,
      provider: m.provider || upstreams[m.upstream]?.protocol || "Custom",
      description: m.description ?? "",
      contextWindow: m.contextWindow,
      reasoningEfforts: m.reasoningEfforts,
      inputPrice: m.inputPrice,
      outputPrice: m.outputPrice,
      pricing: m.pricing,
      consumptionMultiplier: upstreams[m.upstream]?.consumptionMultiplier ?? 1,
      billing: routePricing(m, upstreams[m.upstream]),
      operations: m.operations,
      features: [
        ...((m.operations ?? ["chat"]).includes("chat")
          ? ["text", "tools", "stream", "usage"]
          : ["usage"]),
        ...(m.operations ?? []).filter((operation) => operation !== "chat"),
      ],
    }));
}
export async function readCatalog(
  host: Host,
  input: CatalogScope = {},
  signal?: AbortSignal,
): Promise<CatalogModel[]> {
  if (input.groupId && input.channelId?.startsWith("personal:"))
    throw new HostError("channel_forbidden", "分组密钥不能调用个人渠道", 403);
  const allowed = input.channelIds?.length ? input.channelIds : undefined;
  if (input.channelId && allowed && !allowed.includes(input.channelId))
    throw new HostError("channel_forbidden", "渠道不在密钥授权范围内", 403);
  const group =
    input.personalOnly ||
    input.channelId?.startsWith("personal:") ||
    (!input.groupId && allowed)
      ? undefined
      : resolveGroup(host.config(), input.groupId, input.principalId);
  if (group && input.channelId && !group.channelIds.includes(input.channelId))
    throw new HostError("channel_forbidden", "渠道不在使用分组内", 403);
  const models: CatalogModel[] = (
    input.personalOnly ? [] : catalog(host.config(), input.channelId, input.routeKind)
  )
    .filter(
      (model) =>
        (!allowed || allowed.includes(model.channelId!)) &&
        (!group || group.channelIds.includes(model.channelId!)),
    )
    .map((model) => {
      const billing = groupPricing(model.billing, group);
      return {
        ...model,
        billing,
        consumptionMultiplier:
          (model.consumptionMultiplier ?? 1) * (group?.multiplier ?? 1),
        ...(group
          ? {
              serviceGroup: {
                id: group.id,
                name: group.name,
                multiplier: group.multiplier ?? 1,
              },
            }
          : {}),
      };
    });
  const personal = input.channelId
    ? input.channelId.startsWith("personal:")
      ? [input.channelId]
      : []
    : !input.groupId
      ? allowed?.filter((id) => id.startsWith("personal:"))
      : [];
  if (
    !personal?.length &&
    !(input.includePersonal && !input.channelId && !allowed && !input.groupId)
  )
    return models.sort(
      (a, b) => (b.channelPriority ?? 0) - (a.channelPriority ?? 0),
    );
  if (!input.principalId)
    throw new HostError("unauthorized", "个人渠道需要用户身份", 401);
  if (!host.hasCapability("ai.user-channels@1")) {
    if (input.channelId)
      throw new HostError("channel_not_found", "个人渠道不可用", 404);
    return models;
  }
  const channels = await host.call<PersonalChannel[]>(
    "ai.user-channels@1",
    {
      userId: input.principalId,
      ...(input.channelId || (personal?.length === 1 && allowed?.length === 1)
        ? { id: input.channelId ?? personal![0] }
        : {}),
    },
    signal,
  );
  for (const id of personal ?? channels.map((channel) => channel.id)) {
    const channel = channels.find((item) => item.id === id);
    if (!channel) {
      if (id === input.channelId)
        throw new HostError("channel_not_found", "个人渠道不可用", 404);
      continue;
    }
    models.push(
      ...catalog(
        {
          upstreams: {
            [id]: {
              ...channel.upstream,
              name: channel.name,
              enabled: channel.enabled,
            },
          },
          models: channel.models,
        },
        id,
        input.routeKind,
      ),
    );
  }
  return models.sort(
    (a, b) => (b.channelPriority ?? 0) - (a.channelPriority ?? 0),
  );
}
