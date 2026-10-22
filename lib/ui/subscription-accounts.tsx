import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { useLoad, Notice } from "./mount.js";
import {
  PageHeading,
  Icon,
  Empty,
  Dialog,
  ListPagination,
} from "./components.js";
import { SubscriptionEditor } from "./subscription-editor.js";
import { t as tr, getLocale } from "./i18n.js";
import type { SubscriptionKind } from "../ai/subscription-auth.js";
import {
  installedSubscriptionProviders,
  subscriptionApi,
} from "./subscription-providers.js";
const providers: Record<SubscriptionKind, string> = {
  codex: "Codex",
  "claude-subscription": "Claude",
  antigravity: "Antigravity",
};
const date = (v?: number) =>
  v ? new Date(v).toLocaleString(getLocale(), { hour12: false }) : "—";
const statusLabel = (status: string) =>
  tr(
    (
      {
        ready: "可用",
        disabled: "已停用",
        cooldown: "冷却中",
        reauthorize: "需要重新授权",
        forbidden: "访问受限",
      } as any
    )[status] ?? status,
  );
function ProviderAccounts({
  host,
  personal = false,
  provider,
  onUse,
}: {
  host: UIHost;
  personal?: boolean;
  provider: SubscriptionKind;
  onUse?: (account: any) => void;
}) {
  const api = subscriptionApi(provider) + (personal ? "/personal" : "");
  const data = useLoad<any[]>(() => host.request(api + "/accounts"));
  const [query, setQuery] = React.useState("");
  const [edit, setEdit] = React.useState<any>(),
    [remove, setRemove] = React.useState<any>();
  const [message, setMessage] = React.useState(""),
    [busy, setBusy] = React.useState(false);
  const [page, setPage] = React.useState(1),
    [size, setSize] = React.useState(20);
  const rows = (data.data ?? []).filter((r) =>
    (r.name + " " + (r.accountId ?? "") + " " + (r.projectId ?? ""))
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const current = Math.min(page, Math.max(1, Math.ceil(rows.length / size)));
  async function action(account: any, action: string, extra = {}) {
    setBusy(true);
    setMessage("");
    try {
      await host.request(api + "/account", {
        method: "POST",
        body: JSON.stringify({ id: account.id, action, ...extra }),
      });
      data.reload();
      setRemove(undefined);
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="subscription-page">
      <style>{`.subscription-form{display:grid;gap:12px;margin-top:12px}.subscription-form textarea{min-height:64px;font-family:monospace;font-size:12px}.oauth-connect{display:grid;gap:10px}.subscription-page .subscription-tools{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px}.subscription-tools input{flex:1;min-width:160px}.subscription-tools>button{margin-left:auto}.subscription-page td{vertical-align:middle}.subscription-page td small{display:block;color:var(--muted);margin-top:4px}.subscription-page .row-actions{display:flex;flex-wrap:wrap;gap:4px}.subscription-page .row-actions button{padding:5px 8px;font-size:12px}.subscription-page .subscription-table{overflow:auto}.subscription-form .actions{justify-content:flex-end}`}</style>
      <PageHeading title={providers[provider] + " · " + tr("订阅账号")}>
        <button onClick={() => setEdit({})}>
          <Icon name="plus" size={15} />
          {tr("添加账号")}
        </button>
      </PageHeading>
      <Notice message={message || data.error} />
      <div className="subscription-tools">
        <input
          type="search"
          aria-label={tr("搜索订阅账号")}
          placeholder={tr("搜索账号…")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
        />

        <button
          className="secondary"
          onClick={data.reload}
          aria-label={tr("刷新")}
        >
          <Icon name="refresh" size={15} />
        </button>
      </div>
      {data.data && !rows.length ? (
        <Empty title={tr("暂无订阅账号")} />
      ) : (
        <div className="card subscription-table">
          <table>
            <thead>
              <tr>
                {["名称", "状态", "额度快照", "授权到期", "并发", "操作"].map(
                  (s) => (
                    <th key={s}>{tr(s)}</th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {rows.slice((current - 1) * size, current * size).map((r) => (
                <tr key={r.id}>
                  <td>
                    <strong>{r.name}</strong>
                    {r.projectId && <small>{r.projectId}</small>}
                  </td>
                  <td>
                    <span
                      className={
                        "badge " +
                        (r.status === "ready"
                          ? "ready"
                          : r.status === "disabled"
                            ? "muted"
                            : "pending")
                      }
                    >
                      {statusLabel(r.status)}
                    </span>
                    {r.status === "cooldown" && (
                      <small>{date(r.cooldownUntil)}</small>
                    )}
                    {r.lastStatus && r.lastStatus >= 400 && (
                      <small>HTTP {r.lastStatus}</small>
                    )}
                  </td>
                  <td title={date(r.quotaUpdatedAt)}>
                    {r.quota?.length
                      ? r.quota.map((q: any) => (
                          <div key={q.window} title={date(q.resetAt)}>
                            {q.windowMinutes
                              ? q.windowMinutes >= 1440
                                ? q.windowMinutes / 1440 + "d"
                                : q.windowMinutes / 60 + "h"
                              : q.window}{" "}
                            · {tr("已用 {0}%", { "0": String(q.usedPercent) })}
                          </div>
                        ))
                      : "—"}
                  </td>
                  <td>
                    {date(r.expiresAt)}
                    <small>
                      {r.refreshable ? tr("自动刷新") : tr("无刷新令牌")}
                    </small>
                  </td>
                  <td>
                    {r.active} / {r.maxConcurrency}
                  </td>
                  <td>
                    <div className="row-actions">
                      {onUse && (
                        <button
                          className="ghost"
                          disabled={busy || !r.enabled}
                          onClick={() => onUse(r)}
                        >
                          {tr("添加渠道")}
                        </button>
                      )}
                      <button
                        className="ghost"
                        disabled={busy}
                        onClick={() => setEdit(r)}
                      >
                        {tr("编辑")}
                      </button>
                      <button
                        className="ghost"
                        disabled={busy}
                        onClick={() =>
                          void action(r, "update", { enabled: !r.enabled })
                        }
                      >
                        {r.enabled ? tr("停用") : tr("启用")}
                      </button>
                      {r.enabled && r.refreshable && (
                        <button
                          className="ghost"
                          disabled={busy}
                          onClick={() => void action(r, "refresh")}
                        >
                          {tr("刷新授权")}
                        </button>
                      )}
                      {r.enabled && r.status !== "ready" && (
                        <button
                          className="ghost"
                          disabled={busy}
                          onClick={() => void action(r, "resume")}
                        >
                          {tr("恢复调度")}
                        </button>
                      )}
                      {r.provider === "antigravity" && !r.projectId && (
                        <button
                          className="ghost"
                          disabled={busy}
                          onClick={() => void action(r, "project")}
                        >
                          {tr("发现项目")}
                        </button>
                      )}
                      <button
                        className="ghost danger"
                        disabled={busy}
                        onClick={() => setRemove(r)}
                      >
                        {tr("删除")}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ListPagination
        total={rows.length}
        page={current}
        size={size}
        setPage={setPage}
        setSize={(s) => {
          setSize(s);
          setPage(1);
        }}
      />
      {edit && (
        <SubscriptionEditor
          host={host}
          provider={provider}
          api={api}
          account={edit.id ? edit : undefined}
          close={() => setEdit(undefined)}
          saved={data.reload}
        />
      )}
      {remove && (
        <Dialog title={tr("删除订阅账号")} close={() => setRemove(undefined)}>
          <p>{tr("删除后，引用此账号的渠道将无法再使用它。")}</p>
          <Notice message={message} />
          <div className="actions">
            <button className="secondary" onClick={() => setRemove(undefined)}>
              {tr("取消")}
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() => void action(remove, "delete")}
            >
              {tr("删除")}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}

export function SubscriptionAccounts(props: {
  host: UIHost;
  provider?: SubscriptionKind;
  personal?: boolean;
  onUse?: (account: any) => void;
}) {
  const available = useLoad<SubscriptionKind[]>(() =>
    props.provider
      ? Promise.resolve([props.provider])
      : installedSubscriptionProviders(props.host),
  );
  const [selected, setSelected] = React.useState<SubscriptionKind | "">(
    props.provider ?? "",
  );
  const provider = selected || available.data?.[0];
  return (
    <>
      <Notice message={available.error} />
      {!props.provider && !!available.data?.length && (
        <div
          className="compact-tabs"
          role="tablist"
          aria-label={tr("订阅提供商")}
        >
          {available.data.map((kind) => (
            <button
              key={kind}
              role="tab"
              aria-selected={provider === kind}
              className={provider === kind ? "active" : ""}
              onClick={() => setSelected(kind)}
            >
              {providers[kind]}
            </button>
          ))}
        </div>
      )}
      {provider ? (
        <ProviderAccounts key={provider} {...props} provider={provider} />
      ) : (
        available.data && <Empty title={tr("未安装订阅接入插件")} />
      )}
    </>
  );
}
