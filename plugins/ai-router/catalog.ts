import { HostError, type Host } from "@pluhub/sdk";
import type {
  CatalogModel,
  ModelRoute,
  Upstream,
  PersonalChannel,
} from "@pluhub/contracts/ai";
import { routePricing } from "../../lib/commerce/pricing.js";
import { routeKindForProtocol } from "../../lib/ai/decision-route-kind.js";
import { modelVisible } from "./model-visibility.js";
import type { BillingCustomerStatus } from "@pluhub/contracts/commerce";
import type { RequestPricing } from "@pluhub/contracts/ai";

export interface CatalogScope {
  /** Internal planning and quotes retain models hidden only from user-facing listings. */
  forRouting?: boolean;
  principalId?: string;
  channelId?: string;
  channelIds?: readonly string[];
  includePersonal?: boolean;
  /** Internal routing distinguishes Jev from conversational channels. */
  routeKind?: "chat" | "systemone" | "luna" | "jev";
}

function supportsKind(
  channel: Upstream,
  kind: NonNullable<CatalogScope["routeKind"]>,
) {
  if (!channel.flow) return kind === routeKindForProtocol(channel.protocol);
  const flow = channel.flow;
  const nodes = new Map(flow.nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  function visit(id: string): boolean {
    if (!id || seen.has(id)) return false;
    seen.add(id);
    const node = nodes.get(id);
    if (!node) return false;
    if (node.type === "provider") {
      if (
        flow.bindings?.some(
          (binding) =>
            binding.target === id && binding.input === "upstream.protocol",
        )
      )
        return true;
      const protocol = node.upstream?.protocol ?? channel.protocol;
      return (
        kind === routeKindForProtocol(protocol) ||
        (!!node.fallback && visit(node.fallback))
      );
    }
    if (node.type === "response") return kind === "chat";
    // Delegated targets are resolved and checked after selection.
    if (
      node.type === "upstream" ||
      node.type === "routing" ||
      node.type === "platform"
    )
      return true;
    if (node.type === "branch") return visit(node.yes) || visit(node.no);
    if (node.type === "start") return node.next.some(visit);
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
  const models = (config.models ?? {}) as Record<string, ModelRoute>;
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
  const allowed = input.channelIds?.length ? input.channelIds : undefined;
  if (input.channelId && allowed && !allowed.includes(input.channelId))
    throw new HostError("channel_forbidden", "渠道不在密钥授权范围内", 403);
  const routes = (host.config().models ?? {}) as Record<string, ModelRoute>;
  const status =
    !input.forRouting &&
    input.principalId &&
    Object.values(routes).some((model) =>
      ["paid", "consumed"].includes(model.visibility ?? ""),
    ) &&
    host.hasCapability("billing.customer-status@1")
      ? await host.call<BillingCustomerStatus>(
          "billing.customer-status@1",
          { userId: input.principalId },
          signal,
        )
      : undefined;
  const models: CatalogModel[] = catalog(
    host.config(),
    input.channelId,
    input.routeKind,
  ).filter(
    (model) =>
      (input.forRouting ||
        modelVisible(routes[model.routeId!]!, input.principalId, status)) &&
      (!allowed || allowed.includes(model.channelId!)),
  );
  const personal = input.channelId
    ? input.channelId.startsWith("personal:")
      ? [input.channelId]
      : []
    : allowed?.filter((id) => id.startsWith("personal:"));
  if (
    !personal?.length &&
    !(input.includePersonal && !input.channelId && !allowed)
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
  const fee = host.hasCapability("billing.personal-pricing@1")
    ? await host.call<RequestPricing>("billing.personal-pricing@1", {}, signal)
    : undefined;
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
      ).map((model) => ({ ...model, requestFee: fee?.request ?? 0 })),
    );
  }
  return models.sort(
    (a, b) => (b.channelPriority ?? 0) - (a.channelPriority ?? 0),
  );
}
