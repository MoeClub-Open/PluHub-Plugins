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

export interface CatalogScope {
  principalId?: string;
  channelId?: string;
  channelIds?: readonly string[];
  includePersonal?: boolean;
}
function catalog(
  config: Record<string, any>,
  channelId?: string,
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
        upstreams[m.upstream]!.enabled !== false,
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
  const models = catalog(host.config(), input.channelId).filter(
    (model) => !allowed || allowed.includes(model.channelId!),
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
    { userId: input.principalId },
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
      ),
    );
  }
  return models.sort(
    (a, b) => (b.channelPriority ?? 0) - (a.channelPriority ?? 0),
  );
}
