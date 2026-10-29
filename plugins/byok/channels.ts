import { splitKeys } from "../../lib/ai/upstream-key.js";
import { modelDefinition } from "../../lib/ai/model-definition.js";
import { responseObject } from "../../lib/ai/json-response.js";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  HostError,
  json,
  readObject,
  requiredString,
  type Host,
} from "@pluhub/sdk";
import type {
  PersonalChannel,
  Protocol,
  UpstreamInterface,
  ModelRoute,
  ModelDefinition,
} from "@pluhub/contracts/ai";
import type { ChannelWorkflow } from "@pluhub/contracts/workflow";
import { channelPresets } from "../../lib/ai/channel-presets.js";
import { tokenPrice, newApiPrices } from "../../lib/ai/channel-pricing.js";
import { defaultChannelFlow } from "../../lib/ai/channel-config.js";
import {
  compileWorkflow,
  resolveWorkflowStatic,
  runWorkflow,
  checkProtocolConversion,
  requireIngressProtocol,
} from "../../lib/ai/channel-graph.js";
import { assertPublicUrl } from "../../lib/ai/public-network.js";
import { installChannelAdmin } from "./admin.js";
import { validateOperations } from "../../lib/ai/media.js";
import {
  subscriptionDefaults,
  type SubscriptionKind,
} from "../../lib/ai/subscription-auth.js";
import { discoverConnectionModels } from "../../lib/ai/model-directory.js";
import {
  validateInterfaces,
  resolveInterface,
} from "../../lib/ai/upstream-interfaces.js";

type Model = ModelDefinition & {
  model: string;
  operations?: ModelRoute["operations"];
  inputPrice?: number;
  outputPrice?: number;
  upstreamInputPrice?: number;
  upstreamOutputPrice?: number;
  pricingSource?: string;
};
type Settings = {
  protocol: Protocol | SubscriptionKind | "systemone" | "luna" | "jev";
  baseUrl: string;
  priority: number;
  interfaces?: UpstreamInterface[];
  models: Record<string, Model>;
  flow: ChannelWorkflow;
  subscriptionAccountId?: string;
  authMode?: "cli" | "siwc";
};
export const channelMigration =
  "CREATE TABLE personal_channels(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,preset TEXT NOT NULL,enabled INTEGER NOT NULL,settings_json TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL); CREATE INDEX personal_channels_owner ON personal_channels(user_id);";
export const moderationMigration =
  "ALTER TABLE personal_channels ADD COLUMN admin_blocked INTEGER NOT NULL DEFAULT 0; ALTER TABLE personal_channels ADD COLUMN admin_note TEXT NOT NULL DEFAULT '';";
export function installPersonalChannels(
  host: Host,
  db: DatabaseSync,
  encrypt: (row: any, value: unknown) => string,
) {
  const protocols = [
    "openai-chat",
    "openai-responses",
    "anthropic",
    "gemini",
    "codex",
    "claude-subscription",
    "antigravity",
    "grok",
    "systemone",
    "luna",
    "jev",
  ];
  const session = (principal: any) => {
    if (!principal?.session)
      throw new HostError("session_required", "请登录后管理个人渠道", 403);
    return principal.id as string;
  };
  const rowFor = (id: string, userId: string) => {
    const row = db
      .prepare("SELECT * FROM personal_channels WHERE id=? AND user_id=?")
      .get(id, userId) as any;
    if (!row) throw new HostError("channel_not_found", "个人渠道不存在", 404);
    return row;
  };
  function endpoint(value: string) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new HostError("invalid_upstream", "请输入完整的上游地址");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new HostError(
        "invalid_upstream",
        "上游地址不允许包含凭证、查询参数或片段",
      );
    const allowed = (host.config().allowedPrivateOrigins ?? []) as string[];
    const publicOnly = !allowed.includes(url.origin);
    if (publicOnly) assertPublicUrl(url);
    return { baseUrl: url.href.replace(/\/$/, ""), publicOnly };
  }
  function personalInterfaces(value: unknown, protocol: string) {
    const interfaces = validateInterfaces(value);
    if (interfaces) {
      if (
        Object.hasOwn(subscriptionDefaults, protocol) ||
        ["systemone", "luna", "jev"].includes(protocol)
      )
        throw new HostError(
          "invalid_interfaces",
          "当前上游协议不支持自定义 API 接口",
        );
      for (const route of interfaces)
        if (!host.hasCapability("ai.upstream." + route.protocol + "@1"))
          throw new HostError(
            "adapter_unavailable",
            "接口对应的上游适配器未安装",
            503,
          );
    }
    return interfaces;
  }
  function validateFlow(
    value: unknown,
    models: Record<string, Model>,
    interfaces: UpstreamInterface[] | undefined,
    protocol: string,
  ): ChannelWorkflow {
    const flow = structuredClone(
      value ?? defaultChannelFlow(),
    ) as ChannelWorkflow;
    if (!flow || typeof flow !== "object" || !Array.isArray(flow.nodes))
      throw new HostError("invalid_workflow", "无效的渠道流程");
    for (const node of flow.nodes) {
      if (node.type === "provider" && (node.upstream || node.interfaces))
        throw new HostError(
          "invalid_workflow",
          "个人流程的上游和接口由渠道配置提供",
        );
      if (
        node.type === "value" &&
        (node.valueType === "secret" || node.secretRef !== undefined)
      )
        throw new HostError(
          "invalid_workflow",
          "个人渠道使用渠道中加密保存的凭据",
        );
    }
    const resolved = resolveWorkflowStatic(flow, interfaces, true);
    for (const node of resolved.nodes) {
      switch (node.type) {
        case "start":
        case "protocol":
        case "value":
        case "branch":
        case "compare":
        case "logic":
        case "text":
        case "format":
        case "predicate":
        case "prompt":
        case "reasoning":
        case "maxTokens":
        case "template":
        case "replace":
        case "llm":
        case "jev":
        case "response":
          break;
        case "provider":
          if (
            node.upstream ||
            (node.modelMap &&
              Object.values(node.modelMap).some(
                (target) =>
                  !Object.values(models).some(
                    (model) => model.model === target,
                  ),
              )) ||
            (node.model &&
              !Object.values(models).some((m) => m.model === node.model))
          )
            throw new HostError(
              "invalid_workflow",
              "个人流程的上游由渠道配置提供，节点模型必须在渠道模型列表中",
            );
          personalInterfaces(node.interfaces, protocol);
          break;
        case "platform":
          requiredString(node.groupId, "groupId", 128);
          if (node.model !== undefined)
            requiredString(node.model, "model", 256);
          break;
        case "upstream":
          if (
            !Object.hasOwn(models, node.target) ||
            (node.allowedTargets !== undefined &&
              (!Array.isArray(node.allowedTargets) ||
                node.allowedTargets.some(
                  (target) => !Object.hasOwn(models, target),
                )))
          )
            throw new HostError("invalid_workflow", "只能转到本渠道内的模型");
          break;
        case "rateLimit":
          if (!host.hasCapability("ai.request-limits@1"))
            throw new HostError(
              "adapter_unavailable",
              "请求限流插件未安装或已停用",
              503,
            );
          break;
        case "tps":
          if (node.inheritDefault === false)
            throw new HostError(
              "invalid_workflow",
              "个人渠道不能关闭默认输出限速",
            );
          if (!host.hasCapability("ai.output-pace@2"))
            throw new HostError(
              "adapter_unavailable",
              "TPS 插件未安装或已停用",
              503,
            );
          if (!["o200k_base", "cl100k_base"].includes(node.tokenizer))
            throw new HostError("invalid_workflow", "个人渠道请选择内置分词器");
          break;
        default:
          throw new HostError("invalid_workflow", "个人渠道暂不支持此节点");
      }
    }
    compileWorkflow(flow, interfaces, true);
    return flow;
  }
  function settings(body: any): Settings {
    if (
      !protocols.includes(body.protocol) ||
      !host.hasCapability("ai.upstream." + body.protocol + "@1")
    )
      throw new HostError("invalid_protocol", "请选择已安装的上游协议适配器");
    const subscription = Object.hasOwn(subscriptionDefaults, body.protocol);
    if (
      subscription &&
      !host.hasCapability(`ai.subscription.${body.protocol}@1`)
    )
      throw new HostError("adapter_unavailable", "请先安装订阅账号插件", 503);
    const interfaces = personalInterfaces(body.interfaces, body.protocol);
    const defaultUrl = subscription
      ? subscriptionDefaults[body.protocol as SubscriptionKind].baseUrl
      : undefined;
    if (
      subscription &&
      body.baseUrl &&
      body.baseUrl.replace(/\/$/, "") !== defaultUrl
    )
      throw new HostError(
        "invalid_upstream",
        "订阅授权仅用于对应提供商的官方上游",
      );
    const base = endpoint(
      requiredString(defaultUrl ?? body.baseUrl, "baseUrl", 2048),
    );
    if (!subscription && body.subscriptionAccountId)
      throw new HostError("invalid_credential", "API 上游不能绑定订阅账号");
    if (
      body.authMode !== undefined &&
      (body.protocol !== "codex" || !["cli", "siwc"].includes(body.authMode))
    )
      throw new HostError("invalid_request", "无效的订阅接入模式");
    if (
      !body.models ||
      typeof body.models !== "object" ||
      Array.isArray(body.models)
    )
      throw new HostError("invalid_models", "请添加模型映射");
    const entries = Object.entries(body.models);
    if (!entries.length || entries.length > 256)
      throw new HostError("invalid_models", "模型数量应为 1 到 256 个");
    const models: Record<string, Model> = Object.create(null);
    for (const [alias, raw] of entries) {
      if (
        alias.trim() !== alias ||
        !alias ||
        alias.length > 256 ||
        ["__proto__", "constructor", "prototype"].includes(alias)
      )
        throw new HostError("invalid_models", "无效的公开模型名");
      const model = raw as any;
      validateOperations(model?.operations);
      models[alias] = {
        ...modelDefinition(model),
        model: requiredString(model?.model, "model", 256),
        ...(model?.operations ? { operations: model.operations } : {}),
        inputPrice: tokenPrice(model?.inputPrice),
        outputPrice: tokenPrice(model?.outputPrice),
        upstreamInputPrice: tokenPrice(model?.upstreamInputPrice),
        upstreamOutputPrice: tokenPrice(model?.upstreamOutputPrice),
        pricingSource: model?.pricingSource === "newapi" ? "newapi" : "manual",
      };
    }
    const priority = body.priority ?? 0;
    if (!Number.isSafeInteger(priority) || Math.abs(priority) > 1000000)
      throw new HostError("invalid_priority", "无效的渠道优先级");
    return {
      priority,
      protocol: body.protocol,
      baseUrl: base.baseUrl,
      interfaces,
      models,
      flow: validateFlow(body.flow, models, interfaces, body.protocol),
      ...(subscription
        ? {
            subscriptionAccountId: requiredString(
              body.subscriptionAccountId,
              "subscriptionAccountId",
            ),
            ...(body.protocol === "codex"
              ? { authMode: body.authMode ?? "cli" }
              : {}),
          }
        : {}),
    };
  }
  function metadata(row: any) {
    const config = JSON.parse(row.settings_json) as Settings;
    return {
      id: row.id,
      name: row.name,
      preset: row.preset,
      enabled: !!row.enabled,
      revision: row.revision,
      updatedAt: row.updated_at,
      ...config,
      consumptionMultiplier: 0,
      keyCount:
        (
          db
            .prepare(
              "SELECT key_count FROM credentials WHERE id=? AND user_id=?",
            )
            .get(row.id, row.user_id) as any
        )?.key_count ?? 0,
      hasCredential: !!db
        .prepare("SELECT id FROM credentials WHERE id=? AND user_id=?")
        .get(row.id, row.user_id),
      blocked: !!row.admin_blocked,
      blockReason: row.admin_note,
    };
  }
  function runtime(row: any): PersonalChannel {
    if (row.admin_blocked)
      throw new HostError("channel_blocked", "个人渠道已被管理员封禁", 403);
    if (!row.enabled)
      throw new HostError("channel_disabled", "个人渠道已停用", 403);
    if (
      !db
        .prepare("SELECT id FROM credentials WHERE id=? AND user_id=?")
        .get(row.id, row.user_id)
    )
      throw new HostError("credential_not_found", "渠道凭证已撤销", 403);
    const config = JSON.parse(row.settings_json) as Settings;
    const base = endpoint(config.baseUrl);
    return {
      id: row.id,
      name: row.name,
      enabled: true,
      preset: row.preset,
      revision: row.revision,
      upstream: {
        ...base,
        protocol: config.protocol,
        interfaces: config.interfaces,
        flow: config.flow,
        credentialId: row.id,
        credentialOwner: row.user_id,
        priority: config.priority ?? 0,
        consumptionMultiplier: 0,
        ...(config.subscriptionAccountId
          ? {
              subscriptionAccountIds: [config.subscriptionAccountId],
              ...(config.authMode ? { authMode: config.authMode } : {}),
            }
          : {}),
      },
      models: Object.fromEntries(
        Object.entries(config.models).map(([alias, m]) => [
          alias,
          {
            ...m,
            upstream: row.id,
            effectiveInputPrice: m.upstreamInputPrice ?? m.inputPrice,
            effectiveOutputPrice: m.upstreamOutputPrice ?? m.outputPrice,
          },
        ]),
      ),
    };
  }
  installChannelAdmin(host, db, metadata);
  async function subscriptionCheck(config: Settings, userId: string) {
    if (!config.subscriptionAccountId) return;
    const account = await host.call<any>(
      `ai.subscription.${config.protocol}@1`,
      {
        action: "inspect",
        id: config.subscriptionAccountId,
        ownerId: userId,
        provider: config.protocol,
      },
    );
    if (!account.enabled)
      throw new HostError("subscription_disabled", "订阅账号已停用", 403);
  }
  host.provide("ai.user-channels@1", async ({ userId, id }) => {
    requiredString(userId, "userId");
    if (id) {
      const row = rowFor(id, userId);
      await subscriptionCheck(JSON.parse(row.settings_json), userId);
      return [runtime(row)];
    }
    const rows = db
      .prepare(
        "SELECT * FROM personal_channels WHERE user_id=? AND enabled=1 AND admin_blocked=0 ORDER BY updated_at DESC,id",
      )
      .all(userId)
      .filter(
        (row: any) =>
          !!db
            .prepare("SELECT id FROM credentials WHERE id=? AND user_id=?")
            .get(row.id, userId),
      );
    const result = await Promise.allSettled(
      rows.map(async (row: any) => {
        await subscriptionCheck(JSON.parse(row.settings_json), userId);
        return runtime(row);
      }),
    );
    return result.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  });
  host.api({
    method: "GET",
    path: "/presets",
    access: "authenticated",
    handle: () =>
      json(
        channelPresets.filter(
          (p) =>
            host.hasCapability("ai.upstream." + p.protocol + "@1") &&
            (!p.authorization ||
              host.hasCapability(`ai.subscription.${p.protocol}@1`)),
        ),
      ),
  });
  host.api({
    method: "GET",
    path: "/personal-channels/subscription-models",
    access: "authenticated",
    handle: async (request, ctx) => {
      const userId = session(ctx.principal),
        query = new URL(request.url).searchParams,
        provider = requiredString(
          query.get("provider"),
          "subscription provider",
          64,
        );
      if (!Object.hasOwn(subscriptionDefaults, provider))
        throw new HostError("invalid_provider", "无效的订阅提供商");
      const models = await host.call(
        `ai.subscription.${provider}@1`,
        {
          action: "models",
          id: requiredString(query.get("accountId"), "subscription account"),
          ownerId: userId,
          provider,
        },
        ctx.signal,
      );
      return json({ models });
    },
  });
  host.api({
    method: "GET",
    path: "/personal-channels",
    access: "authenticated",
    handle: (_r, ctx) => {
      const userId = session(ctx.principal);
      return json(
        db
          .prepare(
            "SELECT * FROM personal_channels WHERE user_id=? ORDER BY updated_at DESC,id",
          )
          .all(userId)
          .map(metadata),
      );
    },
  });
  for (const method of ["POST", "PUT"] as const)
    host.api({
      method,
      path: "/personal-channels",
      access: "authenticated",
      handle: async (request, ctx) => {
        const userId = session(ctx.principal),
          body = await readObject(request, 262144);
        const previous =
          method === "PUT"
            ? rowFor(requiredString(body.id, "id"), userId)
            : undefined;
        if (
          !previous &&
          Number(
            (
              db
                .prepare(
                  "SELECT COUNT(*) AS n FROM personal_channels WHERE user_id=?",
                )
                .get(userId) as any
            ).n,
          ) >= 64
        )
          throw new HostError("channel_limit", "最多可保存 64 个个人渠道", 400);
        if (previous && body.revision !== previous.revision)
          throw new HostError(
            "channel_conflict",
            "渠道已被修改，请刷新后重试",
            409,
          );
        if (body.enabled !== undefined && typeof body.enabled !== "boolean")
          throw new HostError("invalid_request", "enabled 必须是布尔值");
        const config = settings(body),
          name = requiredString(body.name, "name", 128);
        const preset = body.preset ?? previous?.preset ?? "custom";
        if (!channelPresets.some((p) => p.id === preset))
          throw new HostError("invalid_preset", "未知渠道预设");
        const id = previous?.id ?? "personal:" + randomUUID();
        const resolved = resolveWorkflowStatic(
          config.flow,
          config.interfaces,
          true,
        );
        if (resolved.nodes.some((node) => node.type === "platform")) {
          const groups = await host.call<{ id: string }[]>("ai.groups@1", {
            userId,
          });
          for (const node of resolved.nodes)
            if (
              node.type === "platform" &&
              !groups.some((group) => group.id === node.groupId)
            )
              throw new HostError(
                "group_unavailable",
                "使用分组已停用或无权访问",
                403,
              );
        }
        await subscriptionCheck(config, userId);
        const kind = config.subscriptionAccountId ? "subscription" : "key";
        const credential = { id, user_id: userId, channel: id, kind };
        const secret =
          body.key === undefined || body.key === ""
            ? undefined
            : requiredString(body.key, "key", 16384);
        if (secret && !splitKeys(secret).length)
          throw new HostError("invalid_credential", "请填写上游密钥");
        if (
          !config.subscriptionAccountId &&
          !secret &&
          !db
            .prepare(
              "SELECT id FROM credentials WHERE id=? AND user_id=? AND kind='key'",
            )
            .get(id, userId)
        )
          throw new HostError("invalid_request", "请填写上游密钥");
        if (config.subscriptionAccountId && secret)
          throw new HostError(
            "invalid_credential",
            "订阅渠道使用订阅账号授权，请勿填写 API Key",
          );
        const encrypted = config.subscriptionAccountId
          ? encrypt(credential, { accountId: config.subscriptionAccountId })
          : secret
            ? encrypt(credential, { key: secret })
            : undefined;
        db.exec("BEGIN IMMEDIATE");
        try {
          if (previous)
            db.prepare(
              "UPDATE personal_channels SET name=?,preset=?,enabled=?,settings_json=?,revision=revision+1,updated_at=? WHERE id=? AND user_id=?",
            ).run(
              name,
              preset,
              body.enabled === false ? 0 : 1,
              JSON.stringify(config),
              Date.now(),
              id,
              userId,
            );
          else
            db.prepare(
              "INSERT INTO personal_channels(id,user_id,name,preset,enabled,settings_json,revision,updated_at) VALUES(?,?,?,?,?,?,1,?)",
            ).run(
              id,
              userId,
              name,
              preset,
              body.enabled === false ? 0 : 1,
              JSON.stringify(config),
              Date.now(),
            );
          if (encrypted)
            db.prepare(
              "INSERT INTO credentials(id,user_id,channel,name,kind,cipher,created_at,key_count) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET cipher=excluded.cipher,name=excluded.name,kind=excluded.kind,key_count=excluded.key_count",
            ).run(
              id,
              userId,
              id,
              name,
              kind,
              encrypted,
              Date.now(),
              secret ? splitKeys(secret).length : 1,
            );
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return json(metadata(rowFor(id, userId)), previous ? 200 : 201);
      },
    });
  host.api({
    method: "DELETE",
    path: "/personal-channels",
    access: "authenticated",
    handle: (request, ctx) => {
      const userId = session(ctx.principal),
        id = requiredString(new URL(request.url).searchParams.get("id"), "id");
      rowFor(id, userId);
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM credentials WHERE channel=? AND user_id=?").run(
          id,
          userId,
        );
        db.prepare(
          "DELETE FROM personal_channels WHERE id=? AND user_id=?",
        ).run(id, userId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return json({ ok: true });
    },
  });
  async function getJSON(
    url: URL,
    headers: Record<string, string>,
    publicOnly: boolean,
    signal: AbortSignal,
  ) {
    const response = await host.call<Response>(
      "http.transport@1",
      { url: url.href, method: "GET", headers, publicOnly },
      signal,
    );
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new HostError("upstream_error", "上游目录或价格接口不可用", 502);
    }
    return responseObject(response, signal, 2_000_000);
  }

  host.api({
    method: "POST",
    path: "/personal-channels/discover",
    audit: false,
    access: "authenticated",
    handle: async (request, ctx) => {
      session(ctx.principal);
      const body = await readObject(request, 65536);
      if (
        !["openai-chat", "openai-responses", "anthropic", "gemini"].includes(
          body.protocol,
        ) ||
        !host.hasCapability("ai.upstream." + body.protocol + "@1")
      )
        throw new HostError(
          "invalid_protocol",
          "请选择已安装的 API 上游适配器",
        );
      const base = endpoint(requiredString(body.baseUrl, "baseUrl", 2048));
      const interfaces = validateInterfaces(body.interfaces);
      const result = await discoverConnectionModels(
        host,
        { ...base, protocol: body.protocol, interfaces },
        ctx.signal,
        splitKeys(requiredString(body.key, "key", 16384))[0],
      );
      if (!result.models.length && result.errors.length)
        throw new HostError(
          "upstream_error",
          result.errors.map((error) => error.message).join("; "),
          502,
        );
      return json({
        models: result.models.map((model) => model.id),
        errors: result.errors,
      });
    },
  });
  host.api({
    method: "POST",
    path: "/personal-channels/sync",
    audit: false,
    access: "authenticated",
    handle: async (request, ctx) => {
      const userId = session(ctx.principal),
        body = await readObject(request);
      const row = rowFor(requiredString(body.id, "id"), userId),
        config = JSON.parse(row.settings_json) as Settings;
      runtime(row);
      const base = endpoint(config.baseUrl),
        url = new URL(base.baseUrl);
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(15000)]);
      if (body.action === "prices") {
        if (row.preset !== "newapi")
          throw new HostError(
            "unsupported_operation",
            "该预设未声明公开价格接口，请手动填写价格",
          );
        url.pathname = "/api/ratio_config";
        const prices = newApiPrices(
          await getJSON(url, {}, base.publicOnly, signal),
        );
        return json({
          prices,
          source: "newapi",
          fetchedAt: Date.now(),
          note: "仅同步基础输入输出 Token 价格，未包含分组折扣、缓存和按次价格；确认后保存生效。",
        });
      }
      if (body.action !== "models")
        throw new HostError("invalid_request", "请选择同步模型或价格");
      if (config.subscriptionAccountId)
        throw new HostError(
          "unsupported_operation",
          "订阅渠道请按提供商授权范围填写模型",
        );
      if (["systemone", "luna", "jev"].includes(config.protocol))
        throw new HostError(
          "unsupported_operation",
          "当前判断协议不支持模型目录同步，请手动填写模型",
        );
      const { secret } = await host.call<{ secret: string }>(
        "credentials.resolve@1",
        { id: row.id, userId },
        signal,
      );
      const result = await discoverConnectionModels(
        host,
        { ...base, protocol: config.protocol, interfaces: config.interfaces },
        signal,
        secret,
      );
      if (!result.models.length && result.errors.length)
        throw new HostError(
          "upstream_error",
          result.errors.map((error) => error.message).join("; "),
          502,
        );
      return json({
        models: result.models.map((model) => model.id),
        errors: result.errors,
      });
    },
  });
  host.api({
    method: "POST",
    path: "/personal-channels/preview",
    audit: false,
    access: "authenticated",
    handle: async (request, ctx) => {
      const userId = session(ctx.principal),
        body = await readObject(request);
      const row = rowFor(requiredString(body.id, "id"), userId),
        config = JSON.parse(row.settings_json) as Settings;
      const ingressProtocol = requireIngressProtocol(
        body.ingressProtocol ?? "openai-chat",
      );
      const interfaces = Object.hasOwn(body, "interfaces")
        ? personalInterfaces(
            body.interfaces === null ? undefined : body.interfaces,
            config.protocol,
          )
        : config.interfaces;
      const result = runWorkflow(
        row.id,
        body.flow
          ? validateFlow(body.flow, config.models, interfaces, config.protocol)
          : config.flow,
        body.request,
        ctx.signal,
        {
          ingressProtocol,
          requestedModel: body.request.model,
          mappedModel:
            config.models[body.request.model]?.model ?? body.request.model,
          personalInterfaces: interfaces,
          personal: true,
        },
      );
      if (result.provider) {
        const node = result.providerNode;
        const model =
          (node?.type === "provider" ? node.model : undefined) ||
          config.models[body.request?.model]?.model ||
          body.request?.model ||
          "";
        checkProtocolConversion(
          ingressProtocol,
          resolveInterface(
            {
              protocol: config.protocol,
              interfaces: node?.interfaces ?? interfaces,
            },
            ingressProtocol,
            model,
          ).protocol,
          result.protocolPolicy,
        );
      }
      delete result.providerNode;
      return json(result);
    },
  });
  host.api({
    method: "POST",
    path: "/personal-channels/test",
    audit: false,
    access: "authenticated",
    handle: async (request, ctx) => {
      const userId = session(ctx.principal),
        body = await readObject(request);
      const id = requiredString(body.id, "id"),
        model = requiredString(body.model, "model", 256);
      const channel = runtime(rowFor(id, userId));
      if (["systemone", "luna", "jev"].includes(channel.upstream.protocol ?? ""))
        throw new HostError(
          "unsupported_operation",
          "判断渠道请通过自动路由或流程中的 Jev 节点调用",
        );
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)]),
        start = performance.now();
      const headers = new Headers(request.headers);
      headers.set("content-type", "application/json");
      headers.set("x-pluhub-channel", id);
      headers.delete("content-length");
      headers.delete("x-pluhub-group");
      const response = await host.dispatch(
        new Request(new URL("/v1/chat/completions", request.url), {
          method: "POST",
          headers,
          signal,
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "Reply OK" }],
            stream: false,
            max_tokens: 64,
          }),
        }),
      );
      const value = await response.json();
      if (!response.ok)
        throw new HostError(
          value.error?.code ?? "upstream_error",
          value.error?.message ?? "渠道测试失败",
          response.status,
        );
      const text = value.choices?.[0]?.message?.content;
      if (value.choices?.[0]?.finish_reason !== "stop" || !text?.trim())
        throw new HostError("upstream_protocol", "上游没有返回完整文本", 502);
      return json({
        ok: true,
        model,
        text,
        usage: value.usage,
        requestId: response.headers.get("x-pluhub-request-id"),
        latencyMs: Math.round(performance.now() - start),
      });
    },
  });
}
