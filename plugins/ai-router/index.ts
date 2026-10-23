import {
  definePlugin,
  HostError,
  json,
  readObject,
  requiredString,
} from "@pluhub/sdk";
import type {
  AIRequest,
  AIEvent,
  Upstream,
  ModelRoute,
  AIPlan,
  RoutingRequest,
  CatalogModel,
  ModelRedirect,
  PersonalChannel,
  Protocol,
  ProviderConnection,
} from "@pluhub/contracts/ai";
import { readCatalog, type CatalogScope } from "./catalog.js";
import { channelScope } from "../../lib/ai/channel-scope.js";
import { redirectModel } from "./redirects.js";
import { routePricing } from "../../lib/commerce/pricing.js";
import { planRoute } from "./planning.js";
import {
  compileWorkflow,
  runWorkflow,
  checkProtocolConversion,
  requireIngressProtocol,
} from "../../lib/ai/channel-graph.js";
import type { WorkflowResult } from "@pluhub/contracts/workflow";
import { channelConnections } from "../../lib/ai/channel-config.js";
import { subscriptionDefaults } from "../../lib/ai/subscription-auth.js";
import { discoverApiModels } from "../../lib/ai/model-directory.js";
import { subscriptionModels } from "../../lib/ai/subscription-models.js";
export { migrateLegacyChannels } from "../../lib/ai/channel-config.js";
export default definePlugin({
  setup(host) {
    const getCatalog = (input?: CatalogScope) => readCatalog(host, input);
    host.provide("ai.catalog@2", getCatalog);
    async function channels(input?: { userId?: string }) {
      const platform = Object.entries(
        (host.config().upstreams ?? {}) as Record<string, Upstream>,
      )
        .filter(([, u]) => u.enabled !== false)
        .map(([id, u]) => ({
          id,
          name: u.name ?? id,
          protocol: channelConnections(u)[0]?.protocol,
          acceptsCredentials: channelConnections(u).length > 0,
          scope: "platform",
          consumptionMultiplier: u.consumptionMultiplier ?? 1,
        }));
      const personal =
        input?.userId && host.hasCapability("ai.user-channels@1")
          ? (
              await host.call<PersonalChannel[]>("ai.user-channels@1", {
                userId: input.userId,
              })
            ).map((c) => ({
              id: c.id,
              name: c.name,
              protocol: c.upstream.protocol,
              acceptsCredentials: false,
              scope: "personal",
              consumptionMultiplier: c.upstream.consumptionMultiplier ?? 1,
            }))
          : [];
      return [...platform, ...personal];
    }
    async function channelModels(id: string, signal: AbortSignal) {
      const channel = (
        (host.config().upstreams ?? {}) as Record<string, Upstream>
      )[id];
      if (!channel) throw new HostError("not_found", "Channel not found", 404);
      const connections = channelConnections(channel);
      if (!connections.length)
        return {
          models: [],
          errors: [{ protocol: "", message: "渠道尚未配置上游节点" }],
        };
      const discovered = await Promise.allSettled(
        connections.map(async (connection: ProviderConnection) => {
          if (Object.hasOwn(subscriptionDefaults, connection.protocol)) {
            const ids = connection.subscriptionAccountIds ?? [];
            if (!ids.length)
              throw new HostError("subscription_missing", "尚未选择订阅账号");
            const providers = await Promise.all(
              ids.map(async (accountId) => {
                const account = await host.call<{
                  enabled: boolean;
                  plan?: string;
                }>(
                  `ai.subscription.${connection.protocol}@1`,
                  {
                    action: "inspect",
                    id: accountId,
                    ownerId: "",
                    provider: connection.protocol,
                  },
                  signal,
                );
                return subscriptionModels(
                  host,
                  connection.protocol as keyof typeof subscriptionDefaults,
                  account.plan,
                  signal,
                );
              }),
            );
            return providers.flat().map((model) => ({
              ...model,
              protocol: connection.protocol,
            }));
          }
          return (await discoverApiModels(host, connection, signal)).map(
            (model) => ({ ...model, protocol: connection.protocol }),
          );
        }),
      );
      const models = new Map<
        string,
        {
          id: string;
          name?: string;
          contextLength?: number;
          maxOutputTokens?: number;
          protocols: string[];
        }
      >();
      const errors: { protocol: string; message: string }[] = [];
      for (const [index, result] of discovered.entries()) {
        if (result.status === "rejected") {
          errors.push({
            protocol: connections[index]!.protocol,
            message:
              result.reason instanceof Error
                ? result.reason.message
                : "模型目录查询失败",
          });
          continue;
        }
        for (const model of result.value) {
          const previous = models.get(model.id);
          models.set(model.id, {
            ...previous,
            ...model,
            contextLength:
              Math.max(
                previous?.contextLength ?? 0,
                model.contextLength ?? 0,
              ) || undefined,
            maxOutputTokens:
              Math.max(
                previous?.maxOutputTokens ?? 0,
                model.maxOutputTokens ?? 0,
              ) || undefined,
            protocols: [
              ...new Set([...(previous?.protocols ?? []), model.protocol]),
            ],
          });
        }
      }
      return {
        models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)),
        errors,
      };
    }
    host.provide("ai.channels@1", channels);
    host.api({
      method: "GET",
      path: "/channels",
      access: "authenticated",
      handle: async (_r, ctx) => {
        if (!ctx.principal?.session)
          throw new HostError("session_required", "请登录后管理渠道", 403);
        return json(await channels({ userId: ctx.principal.id }));
      },
    });
    function physical(
      modelId: string,
      request?: AIRequest,
      path: string[] = [],
      ingressProtocol?: Protocol,
      protocolPolicy?: WorkflowResult["protocolPolicy"],
    ): { plan: AIPlan; route: ModelRoute } {
      if (path.length >= 32 || path.includes(modelId))
        throw new HostError("routing_cycle", "Target channel graph cycle");
      const c = host.config();
      const redirected = redirectModel(
        modelId,
        (c.redirects ?? {}) as Record<string, ModelRedirect>,
      ).model;
      if (redirected !== modelId)
        return physical(
          redirected,
          request,
          [...path, modelId],
          ingressProtocol,
          protocolPolicy,
        );
      const route = (c.models as Record<string, ModelRoute> | undefined)?.[
        modelId
      ];
      const channel =
        route &&
        (c.upstreams as Record<string, Upstream> | undefined)?.[route.upstream];
      if (
        !route ||
        !channel ||
        route.enabled === false ||
        channel.enabled === false
      )
        throw new HostError("model_not_found", "Target model unavailable", 404);
      let upstream = channel;
      let providerModel = route.model;
      if (channel.flow) {
        const result = runWorkflow(
          route.upstream,
          channel.flow,
          request ?? {
            model: modelId,
            messages: [],
            tools: [],
            stream: false,
          },
          new AbortController().signal,
          { ingressProtocol },
        );
        if (result.protocolPolicy && protocolPolicy?.conversion !== "disabled")
          protocolPolicy = result.protocolPolicy;
        if (result.routingProfile)
          throw new HostError(
            "routing_cycle",
            "Automatic router candidates must resolve to provider nodes",
          );
        if (!result.provider)
          return physical(
            result.target,
            result.request,
            [...path, modelId],
            ingressProtocol,
            protocolPolicy,
          );
        const node = channel.flow.nodes.find((n) => n.id === result.providerId);
        upstream =
          node?.type === "provider" && node.upstream ? node.upstream : channel;
        if (node?.type === "provider" && node.model) providerModel = node.model;
      }
      if (
        !upstream.protocol ||
        ["auto-router", "workflow"].includes(upstream.protocol)
      )
        throw new HostError(
          "routing_cycle",
          "Automatic router candidates must resolve to provider nodes",
        );
      checkProtocolConversion(
        ingressProtocol,
        upstream.protocol,
        protocolPolicy,
      );
      return {
        route,
        plan: {
          capability: "ai.upstream." + upstream.protocol + "@1",
          upstream,
          model: providerModel,
          upstreamId: route.upstream,
          targetModelId: modelId,
          pricing: routePricing(route, channel),
        },
      };
    }
    host.provide("ai.targets@1", async (input, signal) => {
      const c = host.config();
      const models = (c.models ?? {}) as Record<string, ModelRoute>;
      const channels = (c.upstreams ?? {}) as Record<string, Upstream>;
      if (input?.target) {
        const target = physical(
          requiredString(input.target, "target"),
          input.request,
          [],
          input.ingressProtocol,
          input.protocolPolicy,
        );
        const { upstream, model } = target.plan;
        if (upstream.subscriptionAccountIds) {
          const state = await host.call<{ available: boolean }>(
            `ai.subscription.${upstream.protocol}@1`,
            {
              action: "availability",
              ids: upstream.subscriptionAccountIds,
              model,
              ownerId: upstream.credentialOwner,
            },
            signal,
          );
          if (!state.available)
            throw new HostError(
              "subscription_unavailable",
              "目标模型的订阅账号暂不可用",
              503,
            );
        }
        return target;
      }
      return Object.entries(models)
        .filter(
          ([, r]) =>
            r.enabled !== false &&
            channels[r.upstream]?.enabled !== false &&
            !!channels[r.upstream] &&
            channelConnections(channels[r.upstream]!).length > 0,
        )
        .map(([id, r]) => ({
          id,
          name: r.name ?? id,
          channel: r.upstream,
          model: r.model,
          protocol: channelConnections(channels[r.upstream]!)[0]?.protocol,
          inputPrice: r.inputPrice,
          outputPrice: r.outputPrice,
          contextWindow: r.contextWindow,
          reasoningEfforts: r.reasoningEfforts,
        }));
    });
    function validateConnection(upstream: Upstream) {
      if (upstream.subscriptionAccountIds) {
        if (!Object.hasOwn(subscriptionDefaults, upstream.protocol!))
          throw new HostError(
            "invalid_config",
            "Subscription accounts require a subscription adapter",
          );
        if (
          upstream.keyRef ||
          upstream.credentialId ||
          !host.hasCapability(`ai.subscription.${upstream.protocol}@1`)
        )
          throw new HostError(
            "invalid_config",
            "Subscription account manager is required; use a single credential source",
          );
      }
      let url: URL;
      try {
        url = new URL(
          upstream.baseUrl ||
            (upstream.subscriptionAccountIds
              ? subscriptionDefaults[
                  upstream.protocol as keyof typeof subscriptionDefaults
                ]?.baseUrl
              : "")!,
        );
      } catch {
        throw new HostError("invalid_config", "Invalid provider URL");
      }
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new HostError("invalid_config", "Invalid provider URL");
      if (!host.hasCapability("ai.upstream." + upstream.protocol + "@1"))
        throw new HostError(
          "invalid_config",
          "Required upstream adapter is not installed",
        );
    }
    host.validateConfig((config) => {
      for (const model of Object.values(config.models ?? {}) as ModelRoute[])
        routePricing(model);
      const upstreams = (config.upstreams ?? {}) as Record<string, Upstream>;
      for (const upstream of Object.values(upstreams)) {
        if (upstream.flow) {
          compileWorkflow(upstream.flow);
          for (const node of upstream.flow.nodes) {
            if (
              node.type === "upstream" &&
              !Object.hasOwn(config.models ?? {}, node.target) &&
              !Object.hasOwn(config.redirects ?? {}, node.target)
            )
              throw new HostError(
                "invalid_config",
                "Channel graph target model is missing: " + node.target,
              );
            if (
              node.type === "provider" &&
              !node.upstream &&
              !upstream.protocol &&
              upstream.enabled !== false
            )
              throw new HostError(
                "invalid_config",
                "Configure the provider node before enabling this channel",
              );
            if (
              node.type === "routing" &&
              !host.hasCapability("ai.auto-routing@1")
            )
              throw new HostError(
                "invalid_config",
                "Automatic router plugin is not installed",
              );
            if (node.type === "tps" && !host.hasCapability("ai.output-pace@2"))
              throw new HostError(
                "invalid_config",
                "TPS nodes require Token Speed",
              );
            if (
              node.type === "rateLimit" &&
              !host.hasCapability("ai.request-limits@1")
            )
              throw new HostError(
                "invalid_config",
                "请求限流节点需要安装请求限流插件",
              );
          }
        }
        for (const connection of channelConnections(upstream))
          validateConnection(connection);
        if (!upstream.protocol) {
          if (!upstream.flow)
            throw new HostError(
              "invalid_config",
              "Channel needs a provider or a graph",
            );
          continue;
        }
        if (upstream.protocol === "workflow") {
          if (!host.hasCapability("ai.workflow@1"))
            throw new HostError(
              "invalid_config",
              "Channel workflow plugin is not installed",
            );
          continue;
        }
        if (upstream.protocol === "auto-router") {
          if (!host.hasCapability("ai.auto-routing@1"))
            throw new HostError(
              "invalid_config",
              "Automatic router plugin is not installed",
            );
          continue;
        }
        validateConnection(upstream);
      }

      for (const route of Object.values(config.models ?? {}) as ModelRoute[])
        if (!Object.hasOwn(upstreams, route.upstream))
          throw new HostError(
            "invalid_config",
            "Model references a missing upstream",
          );
      const redirects = (config.redirects ?? {}) as Record<
        string,
        ModelRedirect
      >;
      for (const [id, rule] of Object.entries(redirects)) {
        if (rule.enabled === false) continue;
        const target = redirectModel(id, redirects).model;
        if (!Object.hasOwn(config.models ?? {}, target))
          throw new HostError(
            "invalid_config",
            "Redirect target model is missing",
          );
      }
    });
    host.route({
      method: "GET",
      path: "/v1/models",
      access: "authenticated",
      handle: async (request, ctx) => {
        const scope = channelScope(
          ctx.principal,
          request.headers.get("x-pluhub-channel") ?? undefined,
        );
        const allowed = ctx.principal?.attributes?.models as
          string[] | undefined;
        const visible = new Map<string, CatalogModel>();
        for (const model of await getCatalog({
          principalId: ctx.principal?.id,
          ...scope,
        }))
          if (
            (!allowed?.length || allowed.includes(model.id)) &&
            !visible.has(model.id)
          )
            visible.set(model.id, model);
        return json({
          object: "list",
          data: [...visible.values()].map((model) => ({
            id: model.id,
            object: "model",
            created: 0,
            owned_by: model.provider,
          })),
        });
      },
    });
    host.provide("ai.routing@2", (request: RoutingRequest, signal) =>
      planRoute(host, request, signal),
    );
    host.provide(
      "ai.execution@1",
      async (
        { plan, request }: { plan: AIPlan; request: AIRequest },
        signal,
      ) => {
        const actual = {
          ...(plan.preparedRequest ?? request),
          model: plan.model,
          ...(plan.reasoning ? { reasoning: plan.reasoning } : {}),
        };
        const events = await host.call<AsyncIterable<AIEvent>>(
          plan.capability,
          {
            request: actual,
            upstream: plan.upstream,
          },
          signal,
        );
        const pacing = host.hasCapability("ai.output-pace@2")
          ? "ai.output-pace@2"
          : "ai.output-pace@1";
        return host.hasCapability(pacing)
          ? host.call<AsyncIterable<AIEvent>>(
              pacing,
              { events, plan, request: actual },
              signal,
            )
          : events;
      },
    );
    host.api({
      method: "POST",
      path: "/graph/preview",
      access: "host.manage",
      handle: async (r, ctx) => {
        const body = await readObject(r);
        const id = requiredString(body.upstream, "upstream");
        const upstream = (
          host.config().upstreams as Record<string, Upstream>
        )?.[id];
        if (!upstream)
          throw new HostError("not_found", "Channel not found", 404);
        if (
          !body.request ||
          !Array.isArray(body.request.messages) ||
          !Array.isArray(body.request.tools)
        )
          throw new HostError(
            "invalid_request",
            "Provide a normalized AI request",
          );
        const flow = upstream.flow ?? {
          entry: "start",
          nodes: [
            { id: "start", type: "start" as const, next: "provider" },
            { id: "provider", type: "provider" as const },
          ],
        };
        const ingressProtocol = requireIngressProtocol(
          body.ingressProtocol ?? "openai-chat",
        );
        const result = runWorkflow(id, flow, body.request, ctx.signal, {
          ingressProtocol,
        });
        if (result.provider) {
          const node = flow.nodes.find((n) => n.id === result.providerId);
          checkProtocolConversion(
            ingressProtocol,
            node?.type === "provider"
              ? (node.upstream?.protocol ?? upstream.protocol)
              : upstream.protocol,
            result.protocolPolicy,
          );
        }
        return json(result);
      },
    });
    host.api({
      method: "GET",
      path: "/targets",
      access: "host.manage",
      handle: async () => json(await host.call("ai.targets@1")),
    });
    host.api({
      method: "GET",
      path: "/models",
      access: "host.manage",
      handle: () => json(host.config().models ?? {}),
    });
    host.api({
      method: "POST",
      path: "/channel-models",
      access: "host.manage",
      handle: async (request, ctx) =>
        json(
          await channelModels(
            requiredString((await readObject(request)).id, "channel id", 256),
            ctx.signal,
          ),
        ),
    });
    host.api({
      method: "POST",
      path: "/test",
      access: "host.manage",
      handle: async (request, ctx) => {
        const body = await readObject(request);
        const id = requiredString(body.upstream, "upstream");
        const publicModel = body.publicModel
          ? requiredString(body.publicModel, "publicModel")
          : undefined;
        const model = publicModel
          ? undefined
          : requiredString(body.model, "model");
        const upstream = (
          (host.config().upstreams ?? {}) as Record<string, Upstream>
        )[id];
        if (!upstream)
          throw new HostError("not_found", "Channel not found", 404);
        if (
          !publicModel &&
          (!upstream.protocol ||
            ["auto-router", "workflow"].includes(upstream.protocol))
        )
          throw new HostError(
            "unsupported_operation",
            "Test virtual channels through their public model or workflow preview",
          );
        const maxTokens = body.maxTokens ?? 256;
        if (!Number.isInteger(maxTokens) || maxTokens < 32 || maxTokens > 1024)
          throw new HostError(
            "invalid_request",
            "Test output budget must be 32..1024 tokens",
          );
        const start = performance.now();
        const signal = AbortSignal.any([
          ctx.signal,
          AbortSignal.timeout(30000),
        ]);
        const task: AIRequest = {
          model: publicModel ?? model!,
          messages: [{ role: "user", text: "Reply OK" }],
          stream: false,
          tools: [],
          maxTokens,
        };
        let plan: AIPlan | undefined;
        if (publicModel) {
          const route = (host.config().models as Record<string, ModelRoute>)?.[
            publicModel
          ];
          if (route?.upstream !== id)
            throw new HostError(
              "invalid_request",
              "Model must belong to the selected channel",
            );
          plan = await planRoute(
            host,
            {
              model: publicModel,
              request: task,
              features: ["text"],
              principalId: ctx.principal?.id,
            },
            signal,
          );
        }
        const events = plan
          ? await host.call<AsyncIterable<AIEvent>>(
              "ai.execution@1",
              { plan, request: task },
              signal,
            )
          : await host.call<AsyncIterable<AIEvent>>(
              "ai.upstream." + upstream.protocol + "@1",
              {
                upstream,
                request: task,
              },
              signal,
            );
        let usage;
        let finished = false;
        let textPresent = false;
        for await (const event of events) {
          if (event.type === "usage") usage = event.usage;
          if (event.type === "text" && event.text.trim()) textPresent = true;
          if (event.type === "finish") finished = event.reason === "stop";
        }
        if (!finished || !textPresent)
          throw new HostError(
            "upstream_protocol",
            "Empty or incomplete test response",
            502,
          );
        return json({
          ok: true,
          latencyMs: Math.round(performance.now() - start),
          usage,
          textPresent,
        });
      },
    });
  },
});
