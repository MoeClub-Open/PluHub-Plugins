import { t as tr, textValue } from "../../lib/ui/i18n.js";
import { UpstreamInterfaces } from "../../lib/ui/upstream-interfaces.js";
import { remapWorkflowInterfaces } from "../../lib/ui/channel-interface-bindings.js";
import { apiProtocols } from "../../lib/ai/upstream-interfaces.js";
import { isDecisionProtocol } from "../../lib/ai/decision-route-kind.js";
import { Select } from "../../lib/ui/select.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { Notice } from "../../lib/ui/mount.js";
import { Dialog } from "../../lib/ui/components.js";
import { parseApiConnection } from "../../lib/ai/personal-api.js";
import { Checkbox } from "../../lib/ui/checkbox.js";
import type { Protocol, UpstreamInterface } from "@pluhub/contracts/ai";
import { PersonalModels, emptyModel, type Model } from "./models-ui.js";
import type { SubscriptionModel } from "../../lib/ai/subscription-models.js";

const api = "/api/plugins/official.byok";

export function withInterfaces(
  editing: any,
  interfaces: UpstreamInterface[] | undefined,
  oldToNew?: readonly number[],
) {
  return {
    ...editing,
    interfaces,
    ...(editing.flow && oldToNew
      ? { flow: remapWorkflowInterfaces(editing.flow, "", true, oldToNew) }
      : {}),
  };
}

export function PersonalChannelEditor({
  host,
  initial,
  initialModels,
  presets,
  subscriptions,
  referenceModels,
  onManageSubscriptions,
  onSaved,
  close,
}: {
  host: UIHost;
  initial: any;
  initialModels: Model[];
  presets: any[];
  subscriptions: any[];
  referenceModels: any[];
  onManageSubscriptions: () => void;
  onSaved: (saved: {
    id: string;
    name: string;
    firstModel?: string;
    isDecision: boolean;
  }) => void;
  close: () => void;
}) {
  const [editing, setEditing] = React.useState(initial);
  const [models, setModels] = React.useState<Model[]>(initialModels);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [synced, setSynced] = React.useState<any>();
  const [connection, setConnection] = React.useState("");
  const [modelCatalog, setModelCatalog] = React.useState<SubscriptionModel[]>(
    [],
  );
  const [catalogLoading, setCatalogLoading] = React.useState(false);
  const [modelPickerOpen, setModelPickerOpen] = React.useState(false);
  const [modelQuery, setModelQuery] = React.useState("");
  const [pickedModels, setPickedModels] = React.useState<string[]>([]);

  const subscription = [
    "codex",
    "claude-subscription",
    "antigravity",
    "grok",
  ].includes(editing.protocol);
  const hasInterfaceBindings = !!editing.flow?.bindings?.some(
    (binding: any) =>
      /^interfaces\.\d+\./.test(binding.input) &&
      editing.flow.nodes.some(
        (node: any) => node.id === binding.target && node.type === "provider",
      ),
  );

  React.useEffect(() => {
    let cancelled = false;
    setModelCatalog([]);
    setModelPickerOpen(false);
    setModelQuery("");
    setPickedModels([]);
    if (!subscription || !editing.subscriptionAccountId) {
      setCatalogLoading(false);
      return;
    }
    setCatalogLoading(true);
    const query = new URLSearchParams({
      provider: editing.protocol,
      accountId: editing.subscriptionAccountId,
    });
    void host
      .request<{ models: SubscriptionModel[] }>(
        api + "/personal-channels/subscription-models?" + query,
      )
      .then((result) => {
        if (!cancelled) setModelCatalog(result.models);
      })
      .catch((error) => {
        if (!cancelled) setMessage((error as Error).message);
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [editing.protocol, editing.subscriptionAccountId, host, subscription]);

  const filteredCatalog = modelCatalog.filter((model) =>
    [model.id, model.name]
      .join(" ")
      .toLowerCase()
      .includes(modelQuery.trim().toLowerCase()),
  );
  const usedModels = new Set(models.map((model) => model.model));
  const pickableCatalog = filteredCatalog.filter(
    (model) => !usedModels.has(model.id),
  );
  const allVisiblePicked =
    pickableCatalog.length > 0 &&
    pickableCatalog.every((model) => pickedModels.includes(model.id));
  const someVisiblePicked =
    !allVisiblePicked &&
    pickableCatalog.some((model) => pickedModels.includes(model.id));

  function addPickedModels() {
    const selected = new Set(pickedModels),
      existing = new Set(models.map((model) => model.model)),
      additions = modelCatalog
        .filter((model) => selected.has(model.id) && !existing.has(model.id))
        .map((model) => ({
          ...emptyModel(),
          alias: model.id,
          model: model.id,
        }));
    setModels(
      [
        ...models.filter((model) => model.alias || model.model),
        ...additions,
      ].slice(0, 256),
    );
    setModelPickerOpen(false);
    setPickedModels([]);
  }

  function toggleVisibleModels(checked: boolean) {
    const ids = pickableCatalog.map((model) => model.id);
    setPickedModels((current) =>
      checked
        ? [...new Set([...current, ...ids])]
        : current.filter((id) => !ids.includes(id)),
    );
  }

  async function sync(action: "models" | "prices") {
    setBusy(true);
    setMessage("");
    try {
      const saved = editing.id && (action === "prices" || !editing.key);
      setSynced(
        await host.request(
          saved
            ? api + "/personal-channels/sync"
            : api + "/personal-channels/discover",
          {
            method: "POST",
            body: JSON.stringify(
              saved
                ? { id: editing.id, action }
                : {
                    protocol: editing.protocol,
                    interfaces: editing.interfaces,
                    baseUrl: editing.baseUrl,
                    key: editing.key,
                  },
            ),
          },
        ),
      );
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={editing.id ? tr("渠道设置") : tr("添加个人渠道")}
      close={() => {
        if (!busy) close();
      }}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const fields = new FormData(e.currentTarget);
          setBusy(true);
          setMessage("");
          try {
            const aliases = models.map((m) => m.alias.trim());
            if (
              !models.length ||
              aliases.some((a) => !a) ||
              new Set(aliases).size !== aliases.length
            )
              throw new Error(tr("请填写至少一个模型，公开模型名不能重复。"));
            const result = await host.request<any>(api + "/personal-channels", {
              method: editing.id ? "PUT" : "POST",
              body: JSON.stringify({
                ...editing,
                key: fields.get("key") || undefined,
                models: Object.fromEntries(
                  models.map((m) => [
                    m.alias.trim(),
                    {
                      ...m.definition,
                      model: m.model.trim(),
                      operations: m.operations,
                      inputPrice:
                        m.inputPrice === "" ? undefined : Number(m.inputPrice),
                      outputPrice:
                        m.outputPrice === ""
                          ? undefined
                          : Number(m.outputPrice),
                      pricingSource: m.pricingSource,
                    },
                  ]),
                ),
              }),
            });
            onSaved({
              id: result?.id ?? editing.id,
              name: editing.name,
              firstModel: aliases[0],
              isDecision: isDecisionProtocol(editing.protocol),
            });
          } catch (error) {
            setMessage((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Notice message={message} />
        {!editing.id && !subscription && (
          <details className="card">
            <summary>{tr("导入 API 连接")}</summary>
            <label>
              {tr("连接 JSON")}
              <textarea
                value={connection}
                autoComplete="off"
                onChange={(e) => setConnection(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                try {
                  setEditing({
                    ...editing,
                    ...parseApiConnection(connection),
                    subscriptionAccountId: undefined,
                    authMode: undefined,
                  });
                  setConnection("");
                  setMessage("");
                } catch (error) {
                  setMessage(tr((error as Error).message));
                }
              }}
            >
              {tr("应用连接")}
            </button>
          </details>
        )}
        <label>
          {tr("渠道预设")}
          <Select
            disabled={busy}
            value={editing.preset}
            onChange={(e) => {
              const p = presets.find((item) => item.id === e.target.value);
              if (p)
                setEditing((current: any) => ({
                  ...withInterfaces(
                    current,
                    apiProtocols.includes(p.protocol)
                      ? current.interfaces
                      : undefined,
                    apiProtocols.includes(p.protocol)
                      ? undefined
                      : current.interfaces?.map(() => -1),
                  ),
                  preset: p.id,
                  protocol: p.protocol,
                  baseUrl: p.baseUrl,
                  name: current.name || (p.id === "custom" ? "" : p.name),
                  key: "",
                  subscriptionAccountId: undefined,
                  authMode: p.protocol === "codex" ? "cli" : undefined,
                }));
            }}
          >
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {tr(p.name)}
              </option>
            ))}
          </Select>
        </label>
        <label>
          {tr("名称")}
          <input
            value={editing.name}
            required
            maxLength={128}
            disabled={busy}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
          />
        </label>
        <label>
          {tr("上游协议")}
          <Select
            disabled={busy}
            value={editing.protocol}
            onChange={(e) => {
              const protocol = e.target.value;
              const hasApiInterfaces = apiProtocols.includes(
                protocol as Protocol,
              );
              setEditing((current: any) => ({
                ...withInterfaces(
                  current,
                  hasApiInterfaces ? current.interfaces : undefined,
                  hasApiInterfaces
                    ? undefined
                    : current.interfaces?.map(() => -1),
                ),
                protocol,
                key: "",
                subscriptionAccountId: undefined,
                authMode: protocol === "codex" ? "cli" : undefined,
                baseUrl:
                  presets.find((p) => p.protocol === protocol)?.baseUrl ??
                  current.baseUrl,
              }));
            }}
          >
            {[
              ...new Set([
                "openai-chat",
                "openai-responses",
                "anthropic",
                "gemini",
                "systemone",
                "luna",
                "jev",
                ...presets.map((p) => p.protocol),
              ]),
            ].map((p) => (
              <option key={p} value={p}>
                {p === "systemone"
                  ? "Jev / System One"
                  : p === "luna"
                    ? "Luna / Decisions"
                    : p === "jev"
                      ? "JEV / Decide"
                      : p}
              </option>
            ))}
          </Select>
        </label>
        {subscription ? (
          <>
            <label>
              {tr("订阅账号")}
              <Select
                value={editing.subscriptionAccountId ?? ""}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    subscriptionAccountId: e.target.value,
                  })
                }
              >
                <option value="">{tr("选择订阅账号")}</option>
                {subscriptions
                  .filter((a) => a.provider === editing.protocol)
                  .map((a) => (
                    <option key={a.id} value={a.id} disabled={!a.enabled}>
                      {a.name}
                    </option>
                  ))}
              </Select>
            </label>
            <button
              type="button"
              className="ghost"
              onClick={onManageSubscriptions}
            >
              {tr("管理自带订阅")}
            </button>
            {editing.protocol === "codex" && (
              <label>
                {tr("Codex 接入方式")}
                <Select
                  value={editing.authMode ?? "cli"}
                  onChange={(e) =>
                    setEditing({ ...editing, authMode: e.target.value })
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
            <label>
              {tr("上游地址")}
              <input
                type="url"
                value={editing.baseUrl}
                required
                maxLength={2048}
                disabled={busy}
                placeholder={
                  editing.protocol === "systemone"
                    ? "https://api.typesafe.ai/v1"
                    : "https://api.example.com"
                }
                onChange={(e) =>
                  setEditing({ ...editing, baseUrl: e.target.value })
                }
              />
            </label>
            <label>
              {editing.hasCredential
                ? tr("更换上游密钥（留空保留）")
                : tr("上游密钥")}
              <textarea
                name="key"
                rows={3}
                autoComplete="off"
                placeholder={tr(
                  editing.hasCredential
                    ? "每行一个 Key；留空保留现有密钥"
                    : "必填，每行一个上游 Key",
                )}
                required={!editing.hasCredential}
                maxLength={16384}
                disabled={busy}
                value={editing.key ?? ""}
                onChange={(e) =>
                  setEditing({ ...editing, key: e.target.value })
                }
              />
            </label>
          </>
        )}
        <details>
          <summary>{tr("路由与优先级（可选）")}</summary>
          <label>
            {tr("优先级")}
            <input
              type="number"
              min="-1000000"
              max="1000000"
              step="1"
              value={editing.priority ?? 0}
              disabled={busy}
              onChange={(e) =>
                setEditing({ ...editing, priority: Number(e.target.value) })
              }
            />
          </label>
          {!subscription && (
            <UpstreamInterfaces
              protocol={editing.protocol}
              value={editing.interfaces}
              hasParameterBindings={hasInterfaceBindings}
              onChange={(interfaces, oldToNew) =>
                setEditing((current: any) =>
                  withInterfaces(current, interfaces, oldToNew),
                )
              }
            />
          )}
        </details>
        <div className="section-heading">
          <strong>{tr("模型映射")}</strong>
          {subscription && (
            <button
              type="button"
              className="secondary"
              disabled={
                busy ||
                catalogLoading ||
                !editing.subscriptionAccountId ||
                !modelCatalog.length
              }
              onClick={() => {
                setPickedModels([]);
                setModelQuery("");
                setModelPickerOpen(true);
              }}
            >
              {catalogLoading ? tr("正在加载模型…") : tr("选择模型")}
            </button>
          )}
          <button
            type="button"
            className="secondary"
            disabled={busy || models.length >= 256}
            onClick={() => setModels([...models, emptyModel()])}
          >
            {subscription ? tr("手动添加") : tr("添加模型")}
          </button>
        </div>
        {subscription && modelPickerOpen && (
          <div className="card">
            <div className="list-toolbar">
              <input
                type="search"
                aria-label={tr("搜索模型")}
                placeholder={tr("搜索模型")}
                value={modelQuery}
                onChange={(e) => setModelQuery(e.target.value)}
              />
            </div>
            <label className="checkbox">
              <Checkbox
                checked={allVisiblePicked}
                indeterminate={someVisiblePicked}
                disabled={!pickableCatalog.length}
                onCheckedChange={(checked) =>
                  toggleVisibleModels(checked === true)
                }
              />
              {tr("全选")}
            </label>
            <div className="subscription-model-options">
              {filteredCatalog.map((model) => {
                const added = usedModels.has(model.id),
                  checked = added || pickedModels.includes(model.id);
                return (
                  <label
                    key={model.id}
                    className="checkbox subscription-model-option"
                  >
                    <Checkbox
                      checked={checked}
                      disabled={added}
                      onCheckedChange={(value) =>
                        setPickedModels((current) =>
                          value === true
                            ? [...new Set([...current, model.id])]
                            : current.filter((id) => id !== model.id),
                        )
                      }
                    />
                    <span>
                      <strong>{model.name}</strong>
                      <small>{model.id}</small>
                    </span>
                  </label>
                );
              })}
            </div>
            {!filteredCatalog.length && (
              <p className="muted">{tr("没有匹配的模型。")}</p>
            )}
            <div className="form-actions">
              <span className="muted">
                {tr("已选择 {0}", { "0": textValue(pickedModels.length) })}
              </span>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setModelPickerOpen(false);
                  setPickedModels([]);
                }}
              >
                {tr("取消")}
              </button>
              <button
                type="button"
                disabled={!pickedModels.length}
                onClick={addPickedModels}
              >
                {tr("添加选中模型")}
              </button>
            </div>
          </div>
        )}
        <PersonalModels
          models={models}
          change={setModels}
          subscription={subscription}
          busy={busy}
          references={referenceModels}
        />
        {subscription && (
          <datalist id="subscription-model-catalog">
            {modelCatalog.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </datalist>
        )}
        {!subscription && !isDecisionProtocol(editing.protocol) && (
          <div className="actions">
            <button
              type="button"
              className="secondary"
              disabled={busy || (!editing.id && !editing.key)}
              onClick={() => void sync("models")}
            >
              {tr("获取上游模型")}
            </button>
            {editing.id && editing.preset === "newapi" && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void sync("prices")}
              >
                {tr("同步上游报价")}
              </button>
            )}
          </div>
        )}
        {synced && (
          <div className="card">
            {synced.errors?.map((error: any, index: number) => (
              <Notice
                key={index}
                message={error.protocol + ": " + error.message}
              />
            ))}
            {synced.models ? (
              <>
                <p>
                  {tr("发现 {0} 个模型，将保留现有映射和价格。", {
                    "0": textValue(synced.models.length),
                  })}
                </p>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    const used = new Set(models.map((m) => m.alias));
                    setModels(
                      [
                        ...models.filter((m) => m.alias || m.model),
                        ...synced.models
                          .filter((m: string) => !used.has(m))
                          .map((m: string) => ({
                            ...emptyModel(),
                            alias: m,
                            model: m,
                          })),
                      ].slice(0, 256),
                    );
                    setSynced(undefined);
                  }}
                >
                  {tr("加入模型列表")}
                </button>
              </>
            ) : (
              <>
                <p>{synced.note}</p>
                <p>
                  {tr("获得 {0} 项报价，只更新匹配模型的价格。", {
                    "0": textValue(Object.keys(synced.prices).length),
                  })}
                </p>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    let count = 0;
                    setModels(
                      models.map((m) => {
                        const p = synced.prices[m.model];
                        if (!p) return m;
                        count++;
                        return {
                          ...m,
                          inputPrice: String(p.inputPrice),
                          outputPrice: String(p.outputPrice),
                          pricingSource: "newapi",
                        };
                      }),
                    );
                    setMessage(
                      tr("已应用 {0} 项报价，请保存。", {
                        "0": textValue(count),
                      }),
                    );
                    setSynced(undefined);
                  }}
                >
                  {tr("应用匹配报价")}
                </button>
              </>
            )}
          </div>
        )}
        <div className="form-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={close}
          >
            {tr("取消")}
          </button>
          <button disabled={busy}>
            {busy ? tr("处理中…") : tr("保存渠道")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
