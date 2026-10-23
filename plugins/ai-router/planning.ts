import { SelectionPool } from "../../lib/ai/selection.js";
import type { WorkflowResult } from "@pluhub/contracts/workflow";
import { validateWebSearchTarget } from "../../lib/ai/web-search.js";
import { HostError, type Host } from "@pluhub/sdk";
import type {
  AIPlan,
  RoutingRequest,
  ModelRoute,
  ModelRedirect,
  Upstream,
  PersonalChannel,
} from "@pluhub/contracts/ai";
import { routePricing } from "../../lib/commerce/pricing.js";
import { subscriptionDefaults } from "../../lib/ai/subscription-auth.js";
import { providerSession } from "../../lib/ai/session.js";
import { geminiEffort } from "../../lib/ai/reasoning.js";
import { readCatalog } from "./catalog.js";
import { validateOperations } from "../../lib/ai/media.js";
import { resolveInterface } from "../../lib/ai/upstream-interfaces.js";
import {
  bindPricingContext,
  capturePricingContext,
} from "../../lib/commerce/expression.js";
import {
  runWorkflow,
  checkProtocolConversion,
} from "../../lib/ai/channel-graph.js";

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
  const requestedModel = input.model;
  const catalog = await readCatalog(
    host,
    {
      principalId: input.principalId,
      channelId: input.channelId,
      channelIds: input.channelIds,
    },
    signal,
  );
  const matches = catalog.filter(
    (model) =>
      (model.id === input.model || model.routeId === input.model) &&
      (model.operations ?? ["chat"]).includes(
        input.request?.operation?.kind ?? "chat",
      ),
  );
  if (!matches.length) {
    if (input.channelIds?.length)
      throw new HostError("model_not_found", "绑定渠道中没有此模型", 404);
    return resolvePlan(host, input, signal, requestedModel);
  }
  let unavailable: unknown;
  for (const priority of [
    ...new Set(matches.map((model) => model.channelPriority ?? 0)),
  ].sort((a, b) => b - a)) {
    const candidates = matches.filter(
      (model) => (model.channelPriority ?? 0) === priority,
    );
    while (candidates.length) {
      const match = channels.choose(
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
      const plan = await resolvePlan(
        host,
        {
          ...input,
          channelId: match.channelId,
          model: match.routeId ?? match.id,
        },
        signal,
        requestedModel,
      );
      if (plan.upstream.subscriptionAccountIds?.length) {
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
            "渠道订阅账号暂不可用",
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

async function resolvePlan(
  host: Host,
  input: RoutingRequest,
  signal: AbortSignal,
  requestedModel: string,
): Promise<AIPlan> {
  let config = host.config();
  let credentialId: string | undefined;
  if (input.channelId?.startsWith("personal:")) {
    if (!input.principalId)
      throw new HostError("unauthorized", "个人渠道需要用户身份", 401);
    const [channel] = await host.call<PersonalChannel[]>(
      "ai.user-channels@1",
      { userId: input.principalId, id: input.channelId },
      signal,
    );
    if (!channel)
      throw new HostError("channel_not_found", "个人渠道不可用", 404);
    credentialId = channel.id;
    config = {
      upstreams: {
        [channel.id]: { ...channel.upstream, enabled: channel.enabled },
      },
      models: channel.models,
    };
  }
  const models = (config.models ?? {}) as Record<string, ModelRoute>;
  const upstreams = (config.upstreams ?? {}) as Record<string, Upstream>;
  const redirects = (config.redirects ?? {}) as Record<string, ModelRedirect>;
  let model = input.model,
    explicit = false,
    prepared = input.request;
  const path: string[] = [],
    workflows: NonNullable<AIPlan["workflows"]> = [];
  const responsePath: string[] = [requestedModel];
  let decision: AIPlan["decision"], logicalUpstreamId: string | undefined;
  let outputPolicy: AIPlan["outputPolicy"], resolved: AIPlan | undefined;
  const requestLimits: NonNullable<AIPlan["requestLimits"]> = [];
  const outputPolicies: (NonNullable<
    WorkflowResult["outputPolicies"]
  >[number] & { channel: string })[] = [];
  let bindingChecked = false;
  let sessionChannel = input.channelId;
  let providerNodeId: string | undefined;
  let consumptionMultiplier: number | undefined;
  let protocolPolicy: WorkflowResult["protocolPolicy"];
  while (path.length < 32) {
    signal.throwIfAborted();
    if (path.includes(model))
      throw new HostError("routing_cycle", "Channel or model redirect cycle");
    path.push(model);
    const redirect = Object.hasOwn(redirects, model)
      ? redirects[model]
      : undefined;
    if (redirect && redirect.enabled !== false) {
      explicit ||= redirect.mode === "explicit";
      model = redirect.target;
      responsePath.push(model);
      continue;
    }
    const route = Object.hasOwn(models, model) ? models[model] : undefined;
    if (!route || route.enabled === false)
      throw new HostError("model_not_found", "Unknown model", 404);
    validateOperations(route.operations);
    if (
      !(route.operations ?? ["chat"]).includes(
        input.request?.operation?.kind ?? "chat",
      )
    )
      throw new HostError(
        "operation_not_supported",
        "Model does not support this endpoint",
        400,
      );
    if (
      !bindingChecked &&
      input.channelId &&
      route.upstream !== input.channelId
    )
      throw new HostError(
        "channel_forbidden",
        "模型不属于 API Key 绑定的渠道",
        403,
      );
    const upstream = upstreams[route.upstream];
    if (!upstream || upstream.enabled === false)
      throw new HostError(
        "invalid_route",
        "Configured upstream is unavailable",
        503,
      );
    if (!bindingChecked) {
      sessionChannel ??= route.upstream;
      consumptionMultiplier = upstream.consumptionMultiplier ?? 1;
      bindingChecked = true;
    }
    let connection: Upstream = upstream;
    providerNodeId = undefined;
    let providerModel = route.model;
    let profile = upstream.protocol === "auto-router" ? route.model : undefined;
    if (upstream.flow) {
      if (!prepared)
        throw new HostError(
          "task_required",
          "Channel workflows require a decoded task",
        );
      const result = runWorkflow(
        route.upstream,
        upstream.flow,
        prepared,
        signal,
        input,
      );
      workflows.push(result.trace);
      requestLimits.push(...(result.requestLimits ?? []));
      outputPolicies.push(
        ...(result.outputPolicies ?? []).map((p) => ({
          ...p,
          channel: route.upstream,
        })),
      );
      prepared = result.request;
      if (result.protocolPolicy && protocolPolicy?.conversion !== "disabled")
        protocolPolicy = result.protocolPolicy;
      explicit ||= result.mode === "explicit";
      if (result.outputPolicy && !result.outputPolicies)
        outputPolicy = {
          ...result.outputPolicy,
          tps: Math.min(
            outputPolicy?.tps ?? Infinity,
            result.outputPolicy.tps ?? Infinity,
          ),
        };
      if (result.provider) {
        providerNodeId = result.providerId;
        const node = upstream.flow?.nodes.find(
          (n) => n.id === result.providerId,
        );
        connection =
          node?.type === "provider" && node.upstream ? node.upstream : upstream;
        if (node?.type === "provider" && node.model) providerModel = node.model;
      } else if (result.routingProfile) {
        profile =
          result.routingProfile === "$model"
            ? route.model
            : result.routingProfile;
      } else {
        model = result.target;
        responsePath.push(model);
        continue;
      }
    }
    if (!profile && !connection.protocol)
      throw new HostError(
        "invalid_route",
        "Channel graph has no provider",
        503,
      );
    if (!profile)
      connection = resolveInterface(
        connection,
        input.ingressProtocol,
        providerModel,
      );
    if (
      ["gemini", "antigravity"].includes(connection.protocol ?? "") &&
      prepared?.reasoning?.effort
    ) {
      prepared = {
        ...prepared,
        reasoning: {
          ...prepared.reasoning,
          effort: geminiEffort(prepared.reasoning.effort),
        },
      };
    }
    if (profile) {
      if (!prepared)
        throw new HostError(
          "task_required",
          "Automatic routing requires a decoded task",
        );
      const selected = await host.call<AIPlan>(
        "ai.auto-routing@1",
        {
          profile,
          request: prepared,
          principalId: input.principalId,
          ingressProtocol: input.ingressProtocol,
          protocolPolicy,
          pricingContext: input.pricingContext,
        },
        signal,
      );
      logicalUpstreamId = route.upstream;
      decision = selected.decision;
      if (!selected.targetModelId)
        throw new HostError(
          "invalid_route",
          "Automatic router returned no target",
        );
      prepared = { ...prepared, reasoning: selected.reasoning };
      // Resolve the selected channel through its own graph as well. The visited
      // path covers both graph redirects and automatic selections.
      model = selected.targetModelId;
      continue;
    } else {
      const prices =
        input.channelId?.startsWith("personal:") &&
        providerModel !== route.model
          ? Object.values(models).filter((m) => m.model === providerModel)
          : [route];
      const pricing = prices[0];
      const knownPrice =
        pricing &&
        prices.every(
          (m) =>
            m.inputPrice === pricing.inputPrice &&
            m.outputPrice === pricing.outputPrice &&
            m.effectiveInputPrice === pricing.effectiveInputPrice &&
            m.effectiveOutputPrice === pricing.effectiveOutputPrice &&
            JSON.stringify(m.pricing) === JSON.stringify(pricing.pricing),
        );
      resolved = {
        capability:
          (prepared?.operation ? "ai.media." : "ai.upstream.") +
          connection.protocol +
          "@1",
        upstream: connection,
        model: providerModel,
        upstreamId: route.upstream,
        targetModelId: model,
        ...(knownPrice
          ? {
              pricing: routePricing(pricing, {
                ...upstream,
                consumptionMultiplier,
              }),
            }
          : {}),
      };
      const effort = prepared?.reasoning?.effort;
      if (
        effort &&
        route.reasoningEfforts &&
        !route.reasoningEfforts.includes(effort)
      )
        throw new HostError(
          "unsupported_reasoning",
          "Selected model does not support this effort",
        );
      resolved.reasoning = prepared?.reasoning;
    }
    break;
  }
  if (!resolved)
    throw new HostError("routing_cycle", "Channel routing exceeds 32 hops");
  for (const rule of outputPolicies) {
    if (
      rule.model &&
      (rule.channel !== resolved.upstreamId || rule.model !== resolved.model)
    )
      continue;
    const previous = outputPolicy;
    outputPolicy = {
      tokenizer:
        !previous || (rule.tps ?? Infinity) <= (previous.tps ?? Infinity)
          ? rule.tokenizer
          : previous.tokenizer,
      ...(previous?.tps || rule.tps
        ? { tps: Math.min(previous?.tps ?? Infinity, rule.tps ?? Infinity) }
        : {}),
      ...(previous?.aggregateTps || rule.aggregateTps
        ? {
            aggregateTps: Math.min(
              previous?.aggregateTps ?? Infinity,
              rule.aggregateTps ?? Infinity,
            ),
          }
        : {}),
      inheritDefault:
        previous?.inheritDefault === false || rule.inheritDefault === false
          ? false
          : true,
    };
  }
  if (requestLimits.length && !host.hasCapability("ai.request-limits@1"))
    throw new HostError(
      "limiter_unavailable",
      "请求限流插件未安装或已停用",
      503,
    );
  if (outputPolicy && !host.hasCapability("ai.output-pace@2"))
    throw new HostError("limiter_unavailable", "TPS 插件未安装或已停用", 503);
  if (
    prepared?.operation &&
    !["openai-chat", "openai-responses"].includes(
      resolved.upstream.protocol ?? "",
    )
  )
    throw new HostError(
      "operation_not_supported",
      "This upstream does not provide OpenAI media endpoints",
      400,
    );
  if (prepared) validateWebSearchTarget(prepared, resolved.upstream);
  if (
    prepared?.webSearch &&
    resolved.upstream.protocol === "openai-chat" &&
    resolved.pricing?.webSearch
  )
    throw new HostError(
      "search_usage_unavailable",
      "Separate search billing requires a Responses upstream with reported tool calls",
      400,
    );
  if (
    prepared?.webSearch &&
    input.ingressProtocol &&
    !["openai-chat", "openai-responses"].includes(input.ingressProtocol)
  )
    throw new HostError(
      "unsupported_feature",
      "Web search output requires a Responses or Chat ingress",
    );
  checkProtocolConversion(
    input.ingressProtocol,
    resolved.upstream.protocol,
    protocolPolicy,
  );
  if (credentialId) {
    if (!input.principalId)
      throw new HostError("unauthorized", "Credential requires a user", 401);
    await host.call(
      "credentials.select@1",
      {
        id: credentialId,
        userId: input.principalId,
        channel: resolved.upstreamId,
      },
      signal,
    );
  }
  if (!host.hasCapability(resolved.capability))
    throw new HostError(
      "adapter_unavailable",
      "Configured upstream adapter is not installed",
      503,
    );
  if (prepared?.sessionId)
    prepared = {
      ...prepared,
      sessionId: providerSession(prepared.sessionId, [
        sessionChannel,
        resolved.upstreamId,
        providerNodeId,
        resolved.upstream.protocol,
        resolved.upstream.baseUrl,
      ]),
    };
  return {
    ...resolved,
    ...(resolved.pricing
      ? {
          pricing: bindPricingContext(
            resolved.pricing,
            input.pricingContext ?? capturePricingContext(input.request),
          ),
        }
      : {}),
    ...(decision ? { decision, logicalUpstreamId } : {}),
    ...(prepared ? { preparedRequest: prepared } : {}),
    upstream: credentialId
      ? {
          ...resolved.upstream,
          subscriptionAccountIds: input.channelId?.startsWith("personal:")
            ? resolved.upstream.subscriptionAccountIds
            : undefined,
          baseUrl:
            resolved.upstream.baseUrl ||
            subscriptionDefaults[
              resolved.upstream.protocol as keyof typeof subscriptionDefaults
            ]?.baseUrl,
          authMode:
            resolved.upstream.authMode ??
            (resolved.upstream.subscriptionAccountIds &&
            resolved.upstream.protocol === "codex"
              ? "cli"
              : undefined),
          credentialId,
          credentialOwner: input.principalId,
        }
      : resolved.upstream,
    credentialId,
    responseModel: explicit
      ? (models[responsePath.at(-1)!]?.publicModel ?? responsePath.at(-1)!)
      : requestedModel,
    ...(requestLimits.length ? { requestLimits } : {}),
    ...(workflows.length
      ? { workflows, preparedRequest: prepared, outputPolicy }
      : {}),
    ...(responsePath.length > 1
      ? {
          redirection: {
            requested: requestedModel,
            target: responsePath.at(-1)!,
            mode: explicit ? "explicit" : "implicit",
            path: responsePath,
          },
        }
      : {}),
  };
}
