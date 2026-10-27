import { SelectionPool } from "../../lib/ai/selection.js";
import { HostError, type Host } from "@pluhub/sdk";
import type { AIPlan, RoutingRequest } from "@pluhub/contracts/ai";
import { readCatalog } from "./catalog.js";
import { resolveRoute } from "./resolution.js";

const channels = new SelectionPool();

export async function planRoute(
  host: Host,
  input: RoutingRequest,
  signal: AbortSignal,
): Promise<AIPlan> {
  if (
    input.channelId &&
    input.channelIds?.length &&
    !input.channelIds.includes(input.channelId)
  )
    throw new HostError("channel_forbidden", "渠道不在密钥授权范围内", 403);
  const requestedModel = input.requestedModel ?? input.model;
  const catalog = await readCatalog(
    host,
    {
      principalId: input.principalId,
      channelId: input.channelId,
      channelIds: input.channelIds,
      groupId: input.groupId,
    },
    signal,
  );
  const publicMatches = catalog.filter((model) => model.id === input.model);
  const named =
    input.requestedModel !== undefined
      ? catalog.filter(
          (model) =>
            model.id === input.requestedModel &&
            (model.routeId ?? model.id) === input.model,
        )
      : publicMatches.length
        ? publicMatches
        : catalog.filter((model) => model.routeId === input.model);
  const matches = named.filter((model) =>
    (model.operations ?? ["chat"]).includes(
      input.request?.operation?.kind ??
        (input.purpose === "quote" ? input.operation : undefined) ??
        "chat",
    ),
  );
  if (!matches.length) {
    if (named.length)
      throw new HostError(
        "operation_not_supported",
        "Model does not support this endpoint",
        400,
      );
    if (input.requestedModel !== undefined)
      throw new HostError("model_not_found", "当前使用范围内没有此模型", 404);
    if (input.channelIds?.length || input.groupId)
      throw new HostError("model_not_found", "绑定渠道中没有此模型", 404);
    return (await resolveRoute(host, input, signal, requestedModel)).plan;
  }
  let unavailable: unknown;
  for (const priority of [
    ...new Set(matches.map((model) => model.channelPriority ?? 0)),
  ].sort((a, b) => b - a)) {
    const candidates = matches.filter(
      (model) => (model.channelPriority ?? 0) === priority,
    );
    while (candidates.length) {
      const match =
        input.purpose === "quote"
          ? candidates[0]!
          : channels.choose(
              JSON.stringify([
                input.principalId,
                requestedModel,
                input.channelId,
                [...(input.channelIds ?? [])].sort(),
              ]),
              candidates,
              (model) => JSON.stringify([model.channelId, model.routeId]),
              input.request?.sessionId,
            )!;
      candidates.splice(candidates.indexOf(match), 1);
      const { plan } = await resolveRoute(
        host,
        {
          ...input,
          channelId: match.channelId,
          model: match.routeId ?? match.id,
        },
        signal,
        requestedModel,
      );
      if (
        input.purpose !== "quote" &&
        plan.upstream.subscriptionAccountIds?.length
      ) {
        const state = await host.call<{ available: boolean }>(
          `ai.subscription.${plan.upstream.protocol}@1`,
          {
            action: "availability",
            ids: plan.upstream.subscriptionAccountIds,
            model: plan.model,
            ownerId: plan.upstream.credentialOwner,
            authMode: plan.upstream.authMode,
          },
          signal,
        );
        if (!state.available) {
          unavailable = new HostError(
            "subscription_unavailable",
            "渠道订阅账号暂不可用，请检查授权状态、额度或模型支持情况",
            503,
          );
          continue;
        }
      }
      return plan;
    }
  }
  throw (
    unavailable ?? new HostError("upstream_unavailable", "没有可用渠道", 503)
  );
}
