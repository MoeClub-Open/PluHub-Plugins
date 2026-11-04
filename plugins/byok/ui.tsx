import { copySecret, SecretCopy } from "../../lib/ui/copy-secret.js";
import { t as tr, textValue } from "../../lib/ui/i18n.js";
import { isDecisionProtocol } from "../../lib/ai/decision-route-kind.js";
import { Select } from "../../lib/ui/select.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { mountPage, useLoad, Notice } from "../../lib/ui/mount.js";
import { Dialog, Icon, ListPagination } from "../../lib/ui/components.js";
import { ChannelGraphEditor } from "../../lib/ui/channel-graph-editor.js";
import { ChannelAdmin } from "./admin-ui.js";
import { SubscriptionAccounts } from "../../lib/ui/subscription-accounts.js";
import { listSubscriptionAccounts } from "../../lib/ui/subscription-providers.js";
import { emptyModel, type Model } from "./models-ui.js";
import { ChannelActions } from "./channel-actions.js";
import { PersonalChannelEditor } from "./editor-ui.js";

const api = "/api/plugins/official.byok";

function Page({ host }: { host: UIHost }) {
  const channels = useLoad<any[]>(() =>
    host.request(api + "/personal-channels"),
  );
  const presets = useLoad<any[]>(() => host.request(api + "/presets"));
  const subscriptions = useLoad<any[]>(() =>
    listSubscriptionAccounts(host, true),
  );
  const apiKeys = useLoad<Array<{ id: string; channelIds?: string[] }>>(() =>
    host.request<any[]>("/api/plugins/official.auth/keys").catch(() => []),
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
    [initialModels, setInitialModels] = React.useState<Model[]>([]),
    [removing, setRemoving] = React.useState<any>();
  const [graph, setGraph] = React.useState<string>(),
    [message, setMessage] = React.useState("");
  const [savedGuide, setSavedGuide] = React.useState<{
    id: string;
    name: string;
    firstModel?: string;
    isDecision: boolean;
  }>();
  const [busy, setBusy] = React.useState(false);
  const [testing, setTesting] = React.useState<any>();
  const [testModel, setTestModel] = React.useState("");
  const [testResult, setTestResult] = React.useState<{
    model: string;
    text: string;
    latencyMs: number;
    usage?: { input: number; output: number };
  }>();
  const [revealed, setRevealed] = React.useState<{
    name: string;
    value: string;
  }>();

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
  const current = Math.min(
    page,
    Math.max(1, Math.ceil(filtered.length / size)),
  );
  const boundKeyCount = (channelId: string) =>
    (apiKeys.data ?? []).filter((key) => key.channelIds?.includes(channelId))
      .length;

  function edit(channel?: any) {
    setMessage("");
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
    setInitialModels(
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
              pricingSource: value.pricingSource,
            }),
          )
        : [emptyModel()],
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
        if (action === "delete" && savedGuide?.id === channel.id)
          setSavedGuide(undefined);
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
            setTab("channels");
            subscriptions.reload();
            setMessage("");
            setInitialModels([emptyModel()]);
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
          {savedGuide && !editing && (
            <div className="card" role="status">
              <div className="section-heading">
                <strong>
                  {tr("已保存渠道「{0}」", {
                    "0": textValue(savedGuide.name),
                  })}
                </strong>
                <div className="actions">
                  <a
                    className="button secondary"
                    href={
                      "#/auth?create=1&channel=" +
                      encodeURIComponent(savedGuide.id)
                    }
                  >
                    {tr("绑定 API 密钥")}
                  </a>
                  {!savedGuide.isDecision && (
                    <a
                      className="button"
                      href={
                        "#/playground?channel=" +
                        encodeURIComponent(savedGuide.id) +
                        (savedGuide.firstModel
                          ? "&model=" +
                            encodeURIComponent(savedGuide.firstModel)
                          : "")
                      }
                    >
                      {tr("在模型试用中打开")}
                    </a>
                  )}
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => setSavedGuide(undefined)}
                  >
                    {tr("关闭")}
                  </button>
                </div>
              </div>
            </div>
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
                onClick={() => {
                  channels.reload();
                  apiKeys.reload();
                }}
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
                  .map((c) => {
                    const boundCount = boundKeyCount(c.id);
                    return (
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
                                )?.name ?? tr("自带订阅")) + " · "
                              : ""}
                            {boundCount > 0
                              ? tr("已绑定 {0} 个密钥", {
                                  "0": textValue(boundCount),
                                })
                              : tr("未绑定密钥")}
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
                                    a.id === c.subscriptionAccountId &&
                                    a.enabled,
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
                                  disabled={
                                    busy ||
                                    c.blocked ||
                                    !c.enabled ||
                                    !c.hasCredential
                                  }
                                  onClick={() => {
                                    setTesting(c);
                                    setTestModel(Object.keys(c.models)[0] ?? "");
                                    setTestResult(undefined);
                                    setMessage("");
                                  }}
                                >
                                  {tr("测试调用")}
                                </button>
                                <a
                                  className="button ghost"
                                  href={
                                    "#/playground?channel=" +
                                    encodeURIComponent(c.id)
                                  }
                                >
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
                    );
                  })}
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
        <PersonalChannelEditor
          key={editing.id ?? "new"}
          host={host}
          initial={editing}
          initialModels={initialModels}
          presets={presets.data ?? []}
          subscriptions={subscriptions.data ?? []}
          referenceModels={referenceModels.data ?? []}
          onManageSubscriptions={() => {
            setEditing(undefined);
            setTab("subscriptions");
            subscriptions.reload();
          }}
          onSaved={(saved) => {
            setEditing(undefined);
            channels.reload();
            apiKeys.reload();
            setSavedGuide(saved);
          }}
          close={() => setEditing(undefined)}
        />
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
