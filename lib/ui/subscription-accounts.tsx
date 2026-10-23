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
  grok: "Grok",
};
const date = (v?: number) =>
  v ? new Date(v).toLocaleString(getLocale(), { hour12: false }) : "—";
const quotaName = (q: any) =>
  [
    q.label,
    q.windowMinutes
      ? q.windowMinutes >= 1440
        ? q.windowMinutes / 1440 + "d"
        : q.windowMinutes / 60 + "h"
      : !q.label
        ? tr("额度")
        : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
const remaining = (q: any) =>
  tr("剩余 {0}%", { "0": Number((100 - q.usedPercent).toFixed(1)) });
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
  const [quota, setQuota] = React.useState<any>();
  const [message, setMessage] = React.useState(""),
    [busy, setBusy] = React.useState(false);
  const [page, setPage] = React.useState(1),
    [size, setSize] = React.useState(20);
  const rows = (data.data ?? []).filter((r) =>
    (
      r.name +
      " " +
      (r.email ?? "") +
      " " +
      (r.accountId ?? "") +
      " " +
      (r.projectId ?? "")
    )
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const current = Math.min(page, Math.max(1, Math.ceil(rows.length / size)));
  async function action(account: any, action: string, extra = {}) {
    setBusy(true);
    setMessage("");
    try {
      const result = await host.request<any>(api + "/account", {
        method: "POST",
        body: JSON.stringify({ id: account.id, action, ...extra }),
      });
      if (action === "quota")
        setQuota((current: any) =>
          current?.id === account.id ? result : current,
        );
      data.reload();
      setRemove(undefined);
      if (action === "delete" && result.revocationConfirmed === false)
        setMessage(
          tr(
            "本地账号已删除，远端授权未确认撤销，可在 ChatGPT 的已连接应用中移除。",
          ),
        );
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="subscription-page">
      <style>{`.subscription-form{display:grid;gap:12px;margin-top:12px}.subscription-form textarea{min-height:64px;font-family:monospace;font-size:12px}.oauth-connect{display:grid;gap:10px}.subscription-page .subscription-tools{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px}.subscription-tools input{flex:1;min-width:160px}.subscription-tools>button{margin-left:auto}.subscription-page td{vertical-align:middle}.subscription-page td small{display:block;color:var(--muted);margin-top:4px}.subscription-page .row-actions{display:flex;flex-wrap:wrap;gap:4px}.subscription-page .row-actions button{padding:5px 8px;font-size:12px}.subscription-page .subscription-table{overflow:auto}.subscription-form .actions{justify-content:flex-end}.subscription-quota-list{display:grid;gap:12px;margin-block:12px}.subscription-quota-row{display:grid;gap:4px}.subscription-quota-row>div{display:flex;justify-content:space-between;gap:12px}.subscription-quota-row progress{width:100%;height:5px;accent-color:var(--accent)}.subscription-quota-row small{color:var(--muted)}`}</style>
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
                {["名称", "状态", "订阅额度", "授权到期", "并发", "操作"].map(
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
                    {r.email && r.email !== r.name && <small>{r.email}</small>}
                    {r.plan && <small>{r.plan}</small>}
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
                    {r.quota?.slice(0, 2).map((q: any) => (
                      <div key={q.window} title={date(q.resetAt)}>
                        {quotaName(q)} · {remaining(q)}
                      </div>
                    ))}
                    <button
                      className="ghost"
                      disabled={busy}
                      onClick={() => {
                        setMessage("");
                        setQuota(r);
                        if (r.enabled) void action(r, "quota");
                      }}
                    >
                      {tr("查看额度")}
                    </button>
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
      {quota && (
        <Dialog
          title={quota.name + " · " + tr("订阅额度")}
          close={() => setQuota(undefined)}
        >
          <Notice message={message} />
          {quota.plan && <p>{quota.plan}</p>}
          <div className="subscription-quota-list">
            {quota.quota?.map((q: any) => (
              <div key={q.window} className="subscription-quota-row">
                <div>
                  <span>{quotaName(q)}</span>
                  <strong>{remaining(q)}</strong>
                </div>
                <progress
                  max={100}
                  value={100 - q.usedPercent}
                  aria-label={quotaName(q) + " · " + remaining(q)}
                />
                {q.resetAt && (
                  <small>{tr("重置于 {0}", { "0": date(q.resetAt) })}</small>
                )}
              </div>
            ))}
            {quota.credits && (
              <div className="subscription-quota-row">
                <div>
                  <span>{tr("可用点数")}</span>
                  <strong>
                    {quota.credits.unlimited
                      ? tr("无限制")
                      : (quota.credits.balance ?? "—")}
                  </strong>
                </div>
              </div>
            )}
            {!quota.quota?.length && !quota.credits && (
              <span className="muted">
                {busy ? tr("正在查询…") : tr("暂无额度数据")}
              </span>
            )}
          </div>
          <div className="actions">
            {quota.quotaUpdatedAt && (
              <small className="muted">
                {tr("更新于 {0}", { "0": date(quota.quotaUpdatedAt) })}
              </small>
            )}
            <button
              className="secondary"
              disabled={busy || !quota.enabled}
              onClick={() => void action(quota, "quota")}
            >
              <Icon name="refresh" size={14} />
              {busy ? tr("正在查询…") : tr("刷新额度")}
            </button>
          </div>
        </Dialog>
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
