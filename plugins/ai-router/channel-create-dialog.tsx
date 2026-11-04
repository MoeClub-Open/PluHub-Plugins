import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import type {
  ModelRoute,
  ProviderConnection,
  Upstream,
} from "@pluhub/contracts/ai";

type UpstreamProtocol = ProviderConnection["protocol"];
import { t as tr, textValue } from "../../lib/ui/i18n.js";
import { Select } from "../../lib/ui/select.js";
import { Checkbox } from "../../lib/ui/checkbox.js";
import { Dialog, Icon } from "../../lib/ui/components.js";
import { Notice } from "../../lib/ui/mount.js";
import { isDecisionProtocol } from "../../lib/ai/decision-route-kind.js";
import { subscriptionDefaults } from "../../lib/ai/subscription-auth.js";
import { defaultChannelFlow } from "../../lib/ai/channel-config.js";
import { listSubscriptionAccounts } from "../../lib/ui/subscription-providers.js";
import {
  availableModelId,
  discoveredModelRoute,
  assignProviderModel,
} from "./model-config.js";
import type { ChannelModel } from "./channel-models.js";

function splitKeys(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n/)
        .map((key) => key.trim())
        .filter(Boolean),
    ),
  ];
}

const protocolOptions: Array<{ id: UpstreamProtocol; label: string }> = [
  { id: "openai-chat", label: "OpenAI Chat (/v1/chat/completions)" },
  { id: "openai-responses", label: "OpenAI Responses (/v1/responses)" },
  { id: "anthropic", label: "Anthropic Messages (/v1/messages)" },
  { id: "gemini", label: "Google Gemini (/v1beta/models)" },
  { id: "codex", label: "Codex 订阅" },
  { id: "claude-subscription", label: "Claude 订阅" },
  { id: "antigravity", label: "Antigravity 订阅" },
  { id: "grok", label: "Grok 订阅" },
  { id: "systemone", label: "Jev / System One" },
  { id: "luna", label: "Luna / Decisions" },
  { id: "jev", label: "JEV / Decide" },
];

type Router = {
  upstreams: Record<string, Upstream>;
  models: Record<string, ModelRoute>;
  nextChannelId?: string;
};

export function ChannelCreateDialog({
  host,
  channelId,
  existing,
  busy,
  save,
  openGraph,
  close,
}: {
  host: UIHost;
  channelId: string;
  existing?: Upstream;
  busy: boolean;
  save: (update: (r: Router) => void) => Promise<void>;
  openGraph: (id: string) => void;
  close: () => void;
}) {
  const isEdit = !!channelId;
  const [name, setName] = React.useState(existing?.name ?? "");
  const [priority, setPriority] = React.useState(
    String(existing?.priority ?? 0),
  );
  const [protocol, setProtocol] =
    React.useState<UpstreamProtocol>("openai-chat");
  const [baseUrl, setBaseUrl] = React.useState("");
  const [rawKeys, setRawKeys] = React.useState("");
  const [authMode, setAuthMode] = React.useState<"cli" | "siwc">("cli");
  const [selectedAccounts, setSelectedAccounts] = React.useState<string[]>([]);
  const [accounts, setAccounts] = React.useState<any[]>([]);
  const [enabled, setEnabled] = React.useState(true);
  const [discovered, setDiscovered] = React.useState<ChannelModel[]>([]);
  const [pickedIds, setPickedIds] = React.useState<string[]>([]);
  const [manualModels, setManualModels] = React.useState("");
  const [modelQuery, setModelQuery] = React.useState("");
  const [discovering, setDiscovering] = React.useState(false);
  const [localError, setLocalError] = React.useState("");

  const isSubscription = Object.hasOwn(subscriptionDefaults, protocol);
  const isDecision = isDecisionProtocol(protocol);

  React.useEffect(() => {
    if (isEdit || !isSubscription) return;
    let active = true;
    void listSubscriptionAccounts(host, false)
      .then((items) => {
        if (!active) return;
        setAccounts(items);
        const matching = items.filter(
          (a) => a.provider === protocol && a.enabled,
        );
        setSelectedAccounts((prev) =>
          prev.filter((id) => matching.some((a) => a.id === id)),
        );
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [host, isEdit, isSubscription, protocol]);

  function buildConnection(): ProviderConnection | undefined {
    const keys = splitKeys(rawKeys);
    if (isSubscription) {
      if (!selectedAccounts.length) return undefined;
      return {
        protocol,
        baseUrl:
          baseUrl.trim() ||
          subscriptionDefaults[protocol as keyof typeof subscriptionDefaults]
            ?.baseUrl ||
          "",
        subscriptionAccountIds: selectedAccounts,
        ...(protocol === "codex" ? { authMode } : {}),
      };
    }
    if (!baseUrl.trim()) return undefined;
    if (!isDecision && !keys.length) return undefined;
    return {
      protocol,
      baseUrl: baseUrl.trim(),
      ...(keys.length ? { keyRef: keys } : {}),
    };
  }

  async function discoverModels() {
    setLocalError("");
    const connection = buildConnection();
    if (!connection) {
      setLocalError(
        isSubscription
          ? tr("请先选择至少一个可用的订阅账号。")
          : tr("请先填写上游地址与上游密钥。"),
      );
      return;
    }
    setDiscovering(true);
    try {
      const secret = splitKeys(rawKeys)[0];
      const result = await host.request<{
        models: ChannelModel[];
        errors: { protocol: string; message: string }[];
      }>("/api/plugins/official.ai-router/channel-models", {
        method: "POST",
        body: JSON.stringify({
          connection: {
            protocol: connection.protocol,
            baseUrl: connection.baseUrl,
            subscriptionAccountIds: connection.subscriptionAccountIds,
            authMode: connection.authMode,
          },
          secret,
        }),
      });
      if (result.errors.length && !result.models.length) {
        setLocalError(result.errors.map((e) => e.message).join(" · "));
      }
      setDiscovered(result.models);
      setPickedIds((prev) =>
        prev.filter((id) => result.models.some((m) => m.id === id)),
      );
    } catch (error) {
      setLocalError((error as Error).message);
    } finally {
      setDiscovering(false);
    }
  }

  const visibleDiscovered = discovered.filter((m) =>
    [m.id, m.name ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(modelQuery.trim().toLowerCase()),
  );
  const allVisiblePicked =
    visibleDiscovered.length > 0 &&
    visibleDiscovered.every((m) => pickedIds.includes(m.id));

  function allocateChannelId(r: Router) {
    let next = BigInt(r.nextChannelId ?? "1");
    for (const current of Object.keys(r.upstreams)) {
      if (!/^\d+$/.test(current)) continue;
      const candidate = BigInt(current) + 1n;
      if (candidate > next) next = candidate;
    }
    const id = String(next);
    r.nextChannelId = String(next + 1n);
    if (Object.hasOwn(r.upstreams, id))
      throw new Error(tr("该 ID 已存在，请使用不同的 ID。"));
    return id;
  }

  async function handleSave(editFlowAfter: boolean) {
    setLocalError("");
    if (isEdit) {
      try {
        await save((r) => {
          r.upstreams[channelId] = {
            ...(existing ?? {}),
            name: name.trim(),
            enabled: existing ? existing.enabled !== false : false,
            flow: existing?.flow ?? defaultChannelFlow(),
            priority: Number(priority || 0),
          };
        });
        if (editFlowAfter) openGraph(channelId);
      } catch (error) {
        setLocalError((error as Error).message);
      }
      return;
    }

    const connection = buildConnection();
    const typedIds = manualModels
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const selectedModels: ChannelModel[] = [
      ...discovered.filter((m) => pickedIds.includes(m.id)),
      ...typedIds
        .filter((id) => !pickedIds.includes(id))
        .map((id) => ({ id, name: id, protocols: [protocol] })),
    ];

    if (!editFlowAfter && !connection) {
      setLocalError(
        isSubscription
          ? tr("请选择订阅账号，或点击「仅创建并编辑流程」进入画布配置。")
          : tr(
              "请填写上游地址和密钥，或点击「仅创建并编辑流程」进入画布配置。",
            ),
      );
      return;
    }

    let createdId = "";
    try {
      await save((r) => {
        createdId = allocateChannelId(r);
        r.upstreams[createdId] = {
          name: name.trim(),
          priority: Number(priority || 0),
          enabled: connection ? enabled : false,
          flow: connection
            ? {
                entry: "start",
                nodes: [
                  { id: "start", type: "start", next: ["provider"] },
                  {
                    id: "provider",
                    type: "provider",
                    upstream: connection,
                    modelMap: {},
                  },
                ],
              }
            : defaultChannelFlow(),
        };
        if (connection && selectedModels.length) {
          for (const model of selectedModels) {
            assignProviderModel(r, createdId, "provider", model.id, model.id);
            const alias = availableModelId(
              Object.keys(r.models),
              createdId,
              model.id,
            );
            r.models[alias] = {
              ...discoveredModelRoute(createdId, model),
              enabled,
            };
          }
        }
      });
      if (editFlowAfter && createdId) openGraph(createdId);
    } catch (error) {
      setLocalError((error as Error).message);
    }
  }

  const providerAccounts = accounts.filter((a) => a.provider === protocol);

  return (
    <Dialog
      title={isEdit ? tr("编辑渠道") : tr("添加渠道")}
      close={() => {
        if (!busy && !discovering) close();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleSave(false);
        }}
      >
        <Notice message={localError} />
        <label>
          {tr("显示名称")}
          <input
            value={name}
            maxLength={128}
            disabled={busy}
            placeholder={tr("便于识别的名称（可选）")}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          {tr("优先级")}
          <input
            type="number"
            min="-1000000"
            max="1000000"
            step="1"
            value={priority}
            disabled={busy}
            required
            onChange={(e) => setPriority(e.target.value)}
          />
        </label>

        {!isEdit && (
          <>
            <label>
              {tr("上游协议")}
              <Select
                value={protocol}
                disabled={busy}
                onChange={(e) => {
                  const next = e.target.value as UpstreamProtocol;
                  setProtocol(next);
                  setDiscovered([]);
                  setPickedIds([]);
                  setLocalError("");
                  if (Object.hasOwn(subscriptionDefaults, next)) {
                    setBaseUrl(
                      subscriptionDefaults[
                        next as keyof typeof subscriptionDefaults
                      ]?.baseUrl ?? "",
                    );
                  }
                }}
              >
                {protocolOptions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {tr(item.label)}
                  </option>
                ))}
              </Select>
            </label>

            {isSubscription ? (
              <>
                <div className="full">
                  <div className="section-heading">
                    <strong>{tr("订阅账号")}</strong>
                    <a className="text-link" href="#/subscriptions">
                      {tr("管理订阅账号")}
                    </a>
                  </div>
                  {providerAccounts.length ? (
                    <div className="subscription-model-options">
                      {providerAccounts.map((account) => (
                        <label
                          key={account.id}
                          className="checkbox subscription-model-option"
                        >
                          <Checkbox
                            checked={selectedAccounts.includes(account.id)}
                            disabled={busy || !account.enabled}
                            onCheckedChange={(checked) =>
                              setSelectedAccounts((prev) =>
                                checked === true
                                  ? [...new Set([...prev, account.id])]
                                  : prev.filter((id) => id !== account.id),
                              )
                            }
                          />
                          <span>
                            <strong>{account.name}</strong>
                            <small>
                              {account.enabled ? tr("已启用") : tr("已停用")}
                            </small>
                          </span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <p className="muted">
                      {tr("暂无该类型的平台订阅账号，请先在订阅账号页面添加。")}
                    </p>
                  )}
                </div>
                {protocol === "codex" && (
                  <label>
                    {tr("Codex 接入方式")}
                    <Select
                      value={authMode}
                      disabled={busy}
                      onChange={(e) =>
                        setAuthMode(e.target.value as "cli" | "siwc")
                      }
                    >
                      <option value="cli">Codex CLI</option>
                      <option value="siwc">Sign in with ChatGPT</option>
                    </Select>
                  </label>
                )}
              </>
            ) : (
              <>
                <label className="full">
                  {tr("上游地址")}
                  <input
                    type="url"
                    value={baseUrl}
                    maxLength={2048}
                    disabled={busy}
                    placeholder={
                      protocol === "systemone"
                        ? "https://api.typesafe.ai/v1"
                        : "https://api.example.com"
                    }
                    onChange={(e) => setBaseUrl(e.target.value)}
                  />
                </label>
                {!isDecision && (
                  <label className="full">
                    {tr("上游密钥")}
                    <textarea
                      rows={3}
                      autoComplete="off"
                      maxLength={16384}
                      disabled={busy}
                      value={rawKeys}
                      placeholder={tr("每行一个上游 API Key")}
                      onChange={(e) => setRawKeys(e.target.value)}
                    />
                  </label>
                )}
              </>
            )}

            {!isDecision && (
              <div className="full">
                <div className="section-heading">
                  <strong>{tr("提供模型")}</strong>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || discovering}
                    onClick={() => void discoverModels()}
                  >
                    <Icon name="refresh" size={14} />
                    {discovering ? tr("正在加载模型…") : tr("获取上游模型")}
                  </button>
                </div>
                {discovered.length > 0 && (
                  <div className="card">
                    <div className="list-toolbar">
                      <input
                        type="search"
                        aria-label={tr("搜索模型")}
                        placeholder={tr("搜索模型")}
                        value={modelQuery}
                        onChange={(e) => setModelQuery(e.target.value)}
                      />
                      <span className="muted">
                        {tr("已选择 {0}", {
                          "0": textValue(pickedIds.length),
                        })}
                      </span>
                    </div>
                    <label className="checkbox">
                      <Checkbox
                        checked={allVisiblePicked}
                        disabled={!visibleDiscovered.length}
                        onCheckedChange={(checked) => {
                          const ids = visibleDiscovered.map((m) => m.id);
                          setPickedIds((prev) =>
                            checked === true
                              ? [...new Set([...prev, ...ids])]
                              : prev.filter((id) => !ids.includes(id)),
                          );
                        }}
                      />
                      {tr("全选")}
                    </label>
                    <div
                      className="subscription-model-options"
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                        gap: "4px 12px",
                        maxHeight: "220px",
                        overflow: "auto",
                        marginTop: "8px",
                      }}
                    >
                      {visibleDiscovered.map((model) => (
                        <label
                          key={model.id}
                          className="checkbox"
                          style={{ minWidth: 0 }}
                        >
                          <Checkbox
                            checked={pickedIds.includes(model.id)}
                            onCheckedChange={(checked) =>
                              setPickedIds((prev) =>
                                checked === true
                                  ? [...new Set([...prev, model.id])]
                                  : prev.filter((id) => id !== model.id),
                              )
                            }
                          />
                          <span
                            style={{
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={model.id}
                          >
                            {model.id}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                {!isSubscription && (
                  <label className="full" style={{ marginTop: "8px" }}>
                    {tr("手动添加模型 ID（可选，逗号或换行分隔）")}
                    <input
                      value={manualModels}
                      disabled={busy}
                      placeholder="gpt-5, claude-sonnet-4-5"
                      onChange={(e) => setManualModels(e.target.value)}
                    />
                  </label>
                )}
              </div>
            )}

            <label className="checkbox full">
              <Checkbox
                checked={enabled}
                disabled={busy}
                onCheckedChange={(checked) => setEnabled(checked === true)}
              />
              {tr("创建后立即启用渠道")}
            </label>
          </>
        )}

        <div className="modal-actions full">
          <button
            type="button"
            className="secondary"
            disabled={busy || discovering}
            onClick={close}
          >
            {tr("取消")}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy || discovering}
            onClick={() => void handleSave(true)}
          >
            {isEdit ? tr("保存并打开流程") : tr("仅创建并编辑流程")}
          </button>
          <button disabled={busy || discovering}>
            {busy ? tr("保存中…") : isEdit ? tr("保存") : tr("创建渠道")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
