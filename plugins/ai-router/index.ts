import { serviceGroups, groupAccess } from "./groups.js";
import { modelDefinition } from "../../lib/ai/model-definition.js";
import { installConfiguration } from "./configuration.js";
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
  ProviderConnection,
} from "@pluhub/contracts/ai";
import { readCatalog, type CatalogScope } from "./catalog.js";
import {
  resolveInterface,
  validateInterfaces,
} from "../../lib/ai/upstream-interfaces.js";
import { channelScope } from "../../lib/ai/channel-scope.js";
import { redirectModel } from "./redirects.js";
import { routePricing } from "../../lib/commerce/pricing.js";
import { planRoute } from "./planning.js";
import { resolveRoute } from "./resolution.js";
import {
  compileWorkflow,
  resolveWorkflowStatic,
  runWorkflow,
  checkProtocolConversion,
  requireIngressProtocol,
} from "../../lib/ai/channel-graph.js";
import { channelConnections } from "../../lib/ai/channel-config.js";
import { keyReferences } from "../../lib/ai/upstream-key.js";
import { subscriptionDefaults } from "../../lib/ai/subscription-auth.js";
import { discoverConnectionModels } from "../../lib/ai/model-directory.js";
export default definePlugin({
  setup(host) {
    installConfiguration(host);
    const groups = (input?: { userId?: string }) =>
      Object.entries(serviceGroups(host.config()))
        .filter(([, group]) => groupAccess(group, input?.userId))
        .map(([id, group]) => ({
          id,
          name: group.name,
          multiplier: group.multiplier ?? 1,
          channelIds:
            group.channelIds ?? Object.keys(host.config().upstreams ?? {}),
        }));
    host.provide("ai.groups@1", groups);
    host.api({
      method: "GET",
      path: "/groups",
      access: "authenticated",
      handle: async (_request, ctx) =>
        json(groups({ userId: ctx.principal?.id })),
    });
    const getCatalog = (input?: CatalogScope) => readCatalog(host, input);
    host.provide("ai.catalog@2", getCatalog);
    async function channels(input?: { userId?: string }) {
      const allowed = new Set(
        groups(input).flatMap((group) => group.channelIds),
      );
      const platform = Object.entries(
        (host.config().upstreams ?? {}) as Record<string, Upstream>,
      )
        .filter(([id, u]) => u.enabled !== false && allowed.has(id))
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
              protocol:
                channelConnections(c.upstream)[0]?.protocol ??
                c.upstream.protocol,
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
                return host.call<
                  import("../../lib/ai/subscription-models.js").SubscriptionModel[]
                >(
                  `ai.subscription.${connection.protocol}@1`,
                  {
                    action: "models",
                    id: accountId,
                    ownerId: "",
                    provider: connection.protocol,
                  },
                  signal,
                );
              }),
            );
            return {
              models: providers.flat().map((model) => ({
                ...model,
                protocols: [connection.protocol],
              })),
              errors: [],
            };
          }
          return discoverConnectionModels(host, connection, signal);
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
        errors.push(...result.value.errors);
        for (const model of result.value.models) {
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
              ...new Set([...(previous?.protocols ?? []), ...model.protocols]),
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
    host.provide("ai.targets@1", async (input, signal) => {
      const c = host.config();
      const models = (c.models ?? {}) as Record<string, ModelRoute>;
      const channels = (c.upstreams ?? {}) as Record<string, Upstream>;
      if (input?.target) {
        const target = await resolveRoute(
          host,
          {
            model: requiredString(input.target, "target"),
            request: input.request,
            features: ["text", "usage"],
            principalId: input.principalId,
            groupId: input.groupId,
            ingressProtocol: input.ingressProtocol,
            pricingContext: input.pricingContext,
          },
          signal,
          input.target,
          {
            physicalOnly: true,
            protocolPolicy: input.protocolPolicy,
            allowedChannelIds: input.allowedChannelIds,
            consumptionMultiplier: input.consumptionMultiplier,
          },
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
              authMode: upstream.authMode,
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
      if (
        upstream.authMode !== undefined &&
        !["siwc", "cli"].includes(upstream.authMode)
      )
        throw new HostError("invalid_config", "无效的订阅接入方式");
      const interfaces = validateInterfaces(upstream.interfaces);
      if (interfaces) {
        if (
          !["openai-chat", "openai-responses", "anthropic", "gemini"].includes(
            upstream.protocol ?? "",
          )
        )
          throw new HostError(
            "invalid_config",
            "订阅授权不支持自定义 API 接口",
          );
        for (const route of interfaces)
          if (!host.hasCapability("ai.upstream." + route.protocol + "@1"))
            throw new HostError("invalid_config", "接口对应的上游适配器未安装");
      }
      if (upstream.subscriptionAccountIds) {
        if (
          !upstream.subscriptionAccountIds.length ||
          upstream.subscriptionAccountIds.length > 100 ||
          new Set(upstream.subscriptionAccountIds).size !==
            upstream.subscriptionAccountIds.length ||
          upstream.subscriptionAccountIds.some((id) => !id || id.length > 256)
        )
          throw new HostError("invalid_config", "无效的订阅账号");
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
      } else if (!keyReferences(upstream.keyRef).length)
        throw new HostError("invalid_config", "请配置上游密钥");
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
      for (const [id, group] of Object.entries(serviceGroups(config))) {
        if (id !== "default" && !Array.isArray(group.channelIds))
          throw new HostError("invalid_config", "分组需要选择渠道");
      }
      for (const model of Object.values(config.models ?? {}) as ModelRoute[]) {
        routePricing(model);
        modelDefinition(model);
        if (model.publicModel !== undefined)
          requiredString(model.publicModel, "publicModel", 256);
      }
      const upstreams = (config.upstreams ?? {}) as Record<string, Upstream>;
      for (const upstream of Object.values(upstreams)) {
        if (upstream.flow) {
          compileWorkflow(upstream.flow);
          for (const node of resolveWorkflowStatic(upstream.flow).nodes) {
            if (
              node.type === "platform" ||
              (node.type === "provider" && node.fallback)
            )
              throw new HostError(
                "invalid_config",
                "平台分组节点仅用于个人渠道",
              );
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
          request.headers.get("x-pluhub-group") ?? undefined,
        );
        const allowed = ctx.principal?.attributes?.models as
          string[] | undefined;
        const visible = new Map<string, CatalogModel>();
        for (const model of await getCatalog({
          principalId: ctx.principal?.id,
          includePersonal: !!ctx.principal?.session,
          ...scope,
        }))
          if (
            (!allowed?.length || allowed.includes(model.id)) &&
            !visible.has(model.id)
          )
            visible.set(model.id, model);
        return Response.json(
          {
            object: "list",
            data: [...visible.values()].map((model) => ({
              id: model.id,
              object: "model",
              created: 0,
              owned_by: model.provider,
            })),
          },
          {
            headers: {
              "cache-control": "private, no-store",
              vary: "Cookie, Authorization, x-pluhub-channel, x-pluhub-group",
            },
          },
        );
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
        return !actual.operation && host.hasCapability("ai.output-pace@2")
          ? host.call<AsyncIterable<AIEvent>>(
              "ai.output-pace@2",
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
        const flow = body.flow ??
          upstream.flow ?? {
            entry: "start",
            nodes: [
              { id: "start", type: "start" as const, next: "provider" },
              { id: "provider", type: "provider" as const },
            ],
          };
        const ingressProtocol = requireIngressProtocol(
          body.ingressProtocol ?? "openai-chat",
        );
        const mapping = Object.entries(
          (host.config().models ?? {}) as Record<string, ModelRoute>,
        )
          .filter(([, model]) => model.upstream === id)
          .find(([key, model]) =>
            body.mappingId
              ? key === body.mappingId
              : key === body.request.model ||
                model.publicModel === body.request.model,
          )?.[1];
        const result = runWorkflow(id, flow, body.request, ctx.signal, {
          ingressProtocol,
          requestedModel: body.request.model,
          mappedModel: mapping?.model ?? body.request.model,
        });
        if (result.provider) {
          const node = result.providerNode;
          const connection =
            node?.type === "provider" && node.upstream
              ? node.upstream
              : upstream;
          const model =
            (node?.type === "provider" ? node.model : undefined) ||
            mapping?.model;
          checkProtocolConversion(
            ingressProtocol,
            resolveInterface(
              connection,
              ingressProtocol,
              model || body.request.model,
            ).protocol,
            result.protocolPolicy,
          );
        }
        delete result.providerNode;
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
          (!upstream.protocol || upstream.protocol === "auto-router")
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
              channelId: id,
              channelIds: [id],
              request: task,
              features: ["text"],
              principalId: ctx.principal?.id,
            },
            signal,
          );
        }
        const direct = !plan
          ? resolveInterface(upstream, body.ingressProtocol, model!)
          : undefined;
        const events = plan
          ? await host.call<AsyncIterable<AIEvent>>(
              "ai.execution@1",
              { plan, request: task },
              signal,
            )
          : await host.call<AsyncIterable<AIEvent>>(
              "ai.upstream." + direct!.protocol + "@1",
              {
                upstream: direct,
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
