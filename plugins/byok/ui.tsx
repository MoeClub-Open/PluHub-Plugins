import { copySecret, SecretCopy } from "../../lib/ui/copy-secret.js";
import { t as tr, textValue } from "../../lib/ui/i18n.js";
import { UpstreamInterfaces } from "../../lib/ui/upstream-interfaces.js";
import { remapWorkflowInterfaces } from "../../lib/ui/channel-interface-bindings.js";
import { apiProtocols } from "../../lib/ai/upstream-interfaces.js";
import { isDecisionProtocol } from "../../lib/ai/decision-route-kind.js";
import { Select } from "../../lib/ui/select.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { mountPage, useLoad, Notice } from "../../lib/ui/mount.js";
import { Dialog, Icon, ListPagination } from "../../lib/ui/components.js";
import { ChannelGraphEditor } from "../../lib/ui/channel-graph-editor.js";
import { ChannelAdmin } from "./admin-ui.js";
import { SubscriptionAccounts } from "../../lib/ui/subscription-accounts.js";
import { parseApiConnection } from "../../lib/ai/personal-api.js";
import { listSubscriptionAccounts } from "../../lib/ui/subscription-providers.js";
import { Checkbox } from "../../lib/ui/checkbox.js";
import type { Protocol, UpstreamInterface } from "@pluhub/contracts/ai";
import { PersonalModels, emptyModel, type Model } from "./models-ui.js";
import { ChannelActions } from "./channel-actions.js";
import type { SubscriptionModel } from "../../lib/ai/subscription-models.js";
const api = "/api/plugins/official.byok";
function withInterfaces(
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
function Page({ host }: { host: UIHost }) {
  const channels = useLoad<any[]>(() =>
    host.request(api + "/personal-channels"),
  );
  const presets = useLoad<any[]>(() => host.request(api + "/presets"));
  const subscriptions = useLoad<any[]>(() =>
    listSubscriptionAccounts(host, true),
  );
  const referenceModels = useLoad<any[]>(() =>
    host
      .request<any[]>("/api/plugins/official.model-catalog/models")
      .then((models) =>
        models.filter((model) => model.channel?.scope === "platform"),
      )
      .catch(() => []),
  );
  const [tab, setTab] = React.useState("channels"),
    [query, setQuery] = React.useState("");
  const [page, setPage] = React.useState(1),
    [size, setSize] = React.useState(10);
  const [editing, setEditing] = React.useState<any>(),
    [removing, setRemoving] = React.useState<any>();
  const [graph, setGraph] = React.useState<string>(),
    [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false),
    [models, setModels] = React.useState<Model[]>([]);
  const [testing, setTesting] = React.useState<any>();
  const [testModel, setTestModel] = React.useState("");
  const [testResult, setTestResult] = React.useState<{
    model: string;
    text: string;
    latencyMs: number;
    usage?: { input: number; output: number };
  }>();
  const [synced, setSynced] = React.useState<any>();
  const [revealed, setRevealed] = React.useState<{
    name: string;
    value: string;
  }>();
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
  ].includes(editing?.protocol);
  const hasInterfaceBindings = !!editing?.flow?.bindings?.some(
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
    if (!subscription || !editing?.subscriptionAccountId) {
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
  }, [editing?.protocol, editing?.subscriptionAccountId, host, subscription]);
  async function copyKeys(channel: any) {
    setBusy(true);
    setMessage("");
    try {
      const value = host
        .request<{ keys: string[] }>(api + "/personal-channels/keys", {
          method: "POST",
          body: JSON.stringify({ id: channel.id }),
        })
        .then((result) => result.keys.join("\n"));
      if (await copySecret(value)) setMessage(tr("密钥已复制"));
      else setRevealed({ name: channel.name, value: await value });
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const filtered = (channels.data ?? []).filter((c) =>
    [c.name, c.baseUrl, ...Object.keys(c.models)]
      .join(" ")
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
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
  const current = Math.min(
    page,
    Math.max(1, Math.ceil(filtered.length / size)),
  );
  function edit(channel?: any) {
    setMessage("");
    setSynced(undefined);
    setConnection("");
    setEditing(
      channel
        ? structuredClone(channel)
        : {
            name: "",
            preset: "custom",
            protocol: "openai-chat",
            baseUrl: "",
            enabled: true,
          },
    );
    setModels(
      channel
        ? Object.entries(channel.models).map(
            ([alias, value]: [string, any]) => ({
              alias,
              definition: {
                name: value.name,
                provider: value.provider,
                description: value.description,
                contextWindow: value.contextWindow,
                reasoningEfforts: value.reasoningEfforts,
                pricing: value.pricing,
              },
              model: value.model,
              operations: value.operations,
              inputPrice:
                value.inputPrice === undefined ? "" : String(value.inputPrice),
              outputPrice:
                value.outputPrice === undefined
                  ? ""
                  : String(value.outputPrice),
              upstreamInputPrice:
                value.upstreamInputPrice === undefined
                  ? ""
                  : String(value.upstreamInputPrice),
              upstreamOutputPrice:
                value.upstreamOutputPrice === undefined
                  ? ""
                  : String(value.upstreamOutputPrice),
              pricingSource: value.pricingSource,
            }),
          )
        : [emptyModel()],
    );
  }
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
  async function mutate(channel: any, action: "state" | "delete" | "test") {
    setBusy(true);
    setMessage("");
    try {
      if (action === "delete")
        await host.request(
          api + "/personal-channels?id=" + encodeURIComponent(channel.id),
          { method: "DELETE" },
        );
      else if (action === "state")
        await host.request(api + "/personal-channels", {
          method: "PUT",
          body: JSON.stringify({ ...channel, enabled: !channel.enabled }),
        });
      else {
        setTestResult(undefined);
        const result = await host.request<any>(
          api + "/personal-channels/test",
          {
            method: "POST",
            body: JSON.stringify({
              id: channel.id,
              model: testModel,
            }),
          },
        );
        setTestResult(result);
        setMessage(
          tr("{0} · {4} 调用成功 · {1} ms · 输入 {2} / 输出 {3} Token", {
            "0": textValue(channel.name),
            "1": textValue(result.latencyMs),
            "2": textValue(result.usage?.input ?? "未知"),
            "3": textValue(result.usage?.output ?? "未知"),
            "4": textValue(result.model),
          }),
        );
      }
      if (action !== "test") {
        channels.reload();
        setRemoving(undefined);
        setMessage(
          action === "delete"
            ? tr("渠道已删除，绑定此渠道的密钥将拒绝调用。")
            : tr("渠道状态已更新。"),
        );
      }
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
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
  if (graph)
    return (
      <ChannelGraphEditor
        host={host}
        channelId={graph}
        personal
        close={() => setGraph(undefined)}
        saved={channels.reload}
      />
    );
  return (
    <>
      <style>{`.modal:has(.personal-models){width:min(1150px,calc(100vw - 32px));max-width:1150px}.modal:has(.personal-models.is-sub){width:min(760px,calc(100vw - 32px))}.personal-models.is-sub table{min-width:420px}.personal-models{overflow-x:auto;margin:10px 0}.personal-models table{min-width:840px}.personal-models input{min-width:92px;width:100%}.personal-models td{padding:7px}.personal-models th{white-space:nowrap}.personal-models small{white-space:nowrap}.subscription-model-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px 14px;max-height:280px;margin:8px 0;overflow:auto}.subscription-model-option{min-width:0;padding:3px 4px}.subscription-model-option span{display:flex;min-width:0;flex-direction:column}.subscription-model-option small{overflow:hidden;text-overflow:ellipsis}.channel-meta{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}@media(max-width:640px){.subscription-model-options{grid-template-columns:minmax(0,1fr)}}`}</style>
      <div className="tabs" role="tablist" aria-label={tr("个人上游管理")}>
        <button
          role="tab"
          aria-selected={tab === "channels"}
          className={tab === "channels" ? "active" : ""}
          onClick={() => setTab("channels")}
        >
          {tr("个人渠道")}
        </button>
        {presets.data?.some((p) => p.authorization === "subscription") && (
          <button
            role="tab"
            aria-selected={tab === "subscriptions"}
            className={tab === "subscriptions" ? "active" : ""}
            onClick={() => setTab("subscriptions")}
          >
            {tr("自带订阅")}
          </button>
        )}
      </div>
      {tab === "subscriptions" ? (
        <SubscriptionAccounts
          host={host}
          personal
          onUse={(account) => {
            edit();
            setTab("channels");
            subscriptions.reload();
            setEditing({
              name: account.name,
              preset: account.provider,
              protocol: account.provider,
              baseUrl:
                presets.data?.find((p) => p.id === account.provider)?.baseUrl ??
                "",
              subscriptionAccountId: account.id,
              authMode:
                account.provider === "codex"
                  ? (account.authMode ?? "cli")
                  : undefined,
              enabled: true,
            });
          }}
        />
      ) : (
        <>
          {!editing && !removing && !testing && (
            <Notice message={message || channels.error || presets.error} />
          )}
          <div className="list-toolbar">
            <input
              type="search"
              aria-label={tr("搜索个人渠道")}
              placeholder={tr("搜索渠道、地址或模型")}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
            />
            <span className="muted">
              {tr("{0} 个渠道", { "0": textValue(channels.data?.length ?? 0) })}
            </span>
            <div className="actions">
              <button
                className="secondary"
                aria-label={tr("刷新个人渠道")}
                title={tr("刷新个人渠道")}
                onClick={channels.reload}
              >
                <Icon name="refresh" size={15} />
              </button>
              <button onClick={() => edit()}>
                <Icon name="plus" size={15} />
                {tr("添加渠道")}
              </button>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{tr("渠道 / 上游")}</th>
                  <th>{tr("模型")}</th>
                  <th>{tr("状态")}</th>
                  <th>{tr("操作")}</th>
                </tr>
              </thead>
              <tbody>
                {filtered
                  .slice((current - 1) * size, current * size)
                  .map((c) => (
                    <tr key={c.id}>
                      <td>
                        <strong>{c.name}</strong>
                        <small className="channel-meta" title={c.baseUrl}>
                          {c.baseUrl}
                        </small>
                        <small>
                          {tr("优先级")} {c.priority ?? 0}
                          {!c.subscriptionAccountId &&
                            ` · ${c.keyCount ?? 1} Key`}
                        </small>
                        <small>
                          {c.subscriptionAccountId ? "BYOSUB" : "BYOAPI"} ·{" "}
                          {c.interfaces
                            ? [
                                ...new Set(
                                  c.interfaces.map(
                                    (route: any) => route.protocol,
                                  ),
                                ),
                              ].join(" · ")
                            : c.protocol}
                        </small>
                      </td>
                      <td>
                        {Object.keys(c.models).length} {tr("个")}
                        <small>
                          {c.subscriptionAccountId
                            ? (subscriptions.data?.find(
                                (a) => a.id === c.subscriptionAccountId,
                              )?.name ?? tr("自带订阅"))
                            : "×0"}
                        </small>
                        <small>
                          {Object.keys(c.models).slice(0, 3).join(", ")}
                        </small>
                      </td>
                      <td>
                        <span
                          className={
                            "badge " +
                            (c.enabled &&
                            c.hasCredential &&
                            (!c.subscriptionAccountId ||
                              subscriptions.data?.some(
                                (a) =>
                                  a.id === c.subscriptionAccountId && a.enabled,
                              ))
                              ? "ready"
                              : "")
                          }
                        >
                          {c.blocked
                            ? tr("管理员封禁")
                            : c.subscriptionAccountId &&
                                !subscriptions.data?.some(
                                  (a) =>
                                    a.id === c.subscriptionAccountId &&
                                    a.enabled,
                                )
                              ? tr("订阅不可用")
                              : !c.hasCredential
                                ? tr("凭证已撤销")
                                : c.enabled
                                  ? tr("已启用")
                                  : tr("已停用")}
                        </span>
                        {c.blocked && <small>{c.blockReason}</small>}
                      </td>
                      <td>
                        <div className="actions">
                          <button
                            className="ghost"
                            disabled={busy}
                            onClick={() => edit(c)}
                          >
                            {tr("设置")}
                          </button>
                          {!isDecisionProtocol(c.protocol) && (
                            <>
                              <button
                                className="ghost"
                                disabled={busy || c.blocked || !c.enabled || !c.hasCredential}
                                onClick={() => {
                                  setTesting(c);
                                  setTestModel(Object.keys(c.models)[0] ?? "");
                                  setTestResult(undefined);
                                  setMessage("");
                                }}
                              >
                                {tr("测试调用")}
                              </button>
                              <a className="button ghost" href={"#/playground?channel=" + encodeURIComponent(c.id)}>
                                {tr("在线对话")}
                              </a>
                            </>
                          )}
                          <ChannelActions
                            channel={c}
                            busy={busy}
                            copy={() => void copyKeys(c)}
                            graph={() => setGraph(c.id)}
                            toggle={() => void mutate(c, "state")}
                            remove={() => {
                              setMessage("");
                              setRemoving(c);
                            }}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                {!filtered.length && (
                  <tr>
                    <td colSpan={4} className="empty-inline">
                      {channels.data
                        ? channels.data.length
                          ? tr("没有匹配的渠道。")
                          : tr("暂无个人渠道")
                        : tr("正在加载渠道…")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <ListPagination
            total={filtered.length}
            page={current}
            size={size}
            setPage={setPage}
            setSize={setSize}
          />
        </>
      )}
      {testing && (
        <Dialog
          title={tr("测试个人渠道")}
          close={() => {
            if (!busy) setTesting(undefined);
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(testing, "test");
            }}
          >
            <strong>{testing.name}</strong>
            <label>
              {tr("测试模型")}
              <Select
                value={testModel}
                disabled={busy}
                onChange={(event) => {
                  setTestModel(event.target.value);
                  setTestResult(undefined);
                  setMessage("");
                }}
              >
                {Object.keys(testing.models).map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </Select>
            </label>
            <small className="field-note">{tr("测试请求使用上游额度。")}</small>
            <Notice message={message} />
            {testResult && (
              <div>
                <strong>{tr("模型回复")}</strong>
                <pre>{testResult.text}</pre>
              </div>
            )}
            <div className="actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setTesting(undefined)}
              >
                {tr("关闭")}
              </button>
              <button disabled={busy || !testModel}>
                {tr(busy ? "正在测试…" : "测试调用")}
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {editing && (
        <Dialog
          title={editing.id ? tr("渠道设置") : tr("添加个人渠道")}
          close={() => {
            if (!busy) setEditing(undefined);
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
                  throw new Error(
                    tr("请填写至少一个模型，公开模型名不能重复。"),
                  );
                await host.request(api + "/personal-channels", {
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
                            m.inputPrice === ""
                              ? undefined
                              : Number(m.inputPrice),
                          outputPrice:
                            m.outputPrice === ""
                              ? undefined
                              : Number(m.outputPrice),
                          upstreamInputPrice:
                            m.upstreamInputPrice === ""
                              ? undefined
                              : Number(m.upstreamInputPrice),
                          upstreamOutputPrice:
                            m.upstreamOutputPrice === ""
                              ? undefined
                              : Number(m.upstreamOutputPrice),
                          pricingSource: m.pricingSource,
                        },
                      ]),
                    ),
                  }),
                });
                setEditing(undefined);
                channels.reload();
                setMessage(tr("已保存"));
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
                  const p = presets.data?.find((p) => p.id === e.target.value);
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
                {presets.data?.map((p) => (
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
                onChange={(e) =>
                  setEditing({ ...editing, name: e.target.value })
                }
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
                      presets.data?.find((p) => p.protocol === protocol)
                        ?.baseUrl ?? current.baseUrl,
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
                    ...(presets.data ?? []).map((p) => p.protocol),
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
                    {subscriptions.data
                      ?.filter((a) => a.provider === editing.protocol)
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
                  onClick={() => {
                    setEditing(undefined);
                    setTab("subscriptions");
                    subscriptions.reload();
                  }}
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
                    {tr("已选择 {0}", {
                      "0": textValue(pickedModels.length),
                    })}
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
              references={referenceModels.data ?? []}
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
              <>
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
              </>
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
                      {tr(
                        "获得 {0} 项报价，只更新匹配模型的上游报价，保留模型原价。",
                        { "0": textValue(Object.keys(synced.prices).length) },
                      )}
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
                              upstreamInputPrice: String(p.inputPrice),
                              upstreamOutputPrice: String(p.outputPrice),
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
                onClick={() => setEditing(undefined)}
              >
                {tr("取消")}
              </button>
              <button disabled={busy}>
                {busy ? tr("处理中…") : tr("保存渠道")}
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {revealed && (
        <Dialog
          title={revealed.name}
          close={() => {
            setRevealed(undefined);
            setMessage("");
          }}
        >
          <Notice message={message} />
          <SecretCopy
            value={revealed.value}
            close={() => {
              setRevealed(undefined);
              setMessage("");
            }}
            onMessage={setMessage}
          />
        </Dialog>
      )}
      {removing && (
        <Dialog
          title={tr("删除个人渠道")}
          close={() => {
            if (!busy) setRemoving(undefined);
          }}
        >
          <Notice message={message} />
          <p>
            {tr(
              "删除「{0}」及其上游凭证？绑定此渠道的 Key 将立即拒绝新请求，请先为需要保留的应用更换绑定。",
              { "0": textValue(removing.name) },
            )}
          </p>
          <div className="form-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setRemoving(undefined)}
            >
              {tr("保留渠道")}
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() => void mutate(removing, "delete")}
            >
              {tr("确认删除")}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
export const mount = (el: HTMLElement, host: UIHost) =>
  mountPage(
    el,
    host,
    host.page === "/settings/user-channels" ? ChannelAdmin : Page,
  );
