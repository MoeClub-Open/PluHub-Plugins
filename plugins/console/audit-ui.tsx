import { t as tr, getLocale } from "../../lib/ui/i18n.js";
import { Select } from "../../lib/ui/select.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { useLoad, Notice } from "../../lib/ui/mount.js";
import { PageHeading, ListPagination, Icon } from "../../lib/ui/components.js";
import { SecurityHistory } from "../../lib/ui/security-history.js";
import { auditAction } from "./audit-actions.js";
const fields = [
  "q",
  "userId",
  "actorId",
  "result",
  "requestId",
  "method",
  "from",
  "to",
] as const;
type Filters = Record<(typeof fields)[number], string>;
const empty = Object.fromEntries(fields.map((key) => [key, ""])) as Filters;
function draftFilters(filters: Filters): Filters {
  const draft = { ...filters };
  for (const key of ["from", "to"] as const) {
    const date = new Date(Number(filters[key]));
    draft[key] =
      filters[key] && Number.isFinite(date.getTime())
        ? new Date(date.getTime() - date.getTimezoneOffset() * 60000)
            .toISOString()
            .slice(0, 16)
        : "";
  }
  return draft;
}
export function AuditPage({
  client,
}: {
  client: UIHost;
}) {
  const plugins = useLoad<
    { id: string; state: string; manifest?: { provides?: string[] } }[]
  >(() => client.request("/api/host/plugins"), [client]);
  if (!plugins.data)
    return (
      <>
        <Notice message={plugins.error} />
        {plugins.error ? (
          <button className="secondary" onClick={plugins.reload}>
            {tr("重试")}
          </button>
        ) : (
          <p role="status">{tr("加载中…")}</p>
        )}
      </>
    );
  const securityHistory = plugins.data.some(
    (plugin) =>
      plugin.id === "official.auth" &&
      plugin.state === "Active" &&
      plugin.manifest?.provides?.includes("auth.security-history@1"),
  );
  const security =
    securityHistory &&
    new URLSearchParams(location.hash.split("?")[1]).get("view") === "security";
  const navigation = securityHistory ? (
    <nav className="tabs" aria-label={tr("审计记录分类")}>
      <a className={!security ? "active" : ""} href="#/audit">
        {tr("管理操作")}
      </a>
      <a className={security ? "active" : ""} href="#/audit?view=security">
        {tr("账号安全")}
      </a>
    </nav>
  ) : undefined;
  return security ? (
    <SecurityHistory host={client} administrative navigation={navigation} />
  ) : (
    <ManagementAudit client={client} navigation={navigation} />
  );
}
function ManagementAudit({
  client,
  navigation,
}: {
  client: UIHost;
  navigation?: React.ReactNode;
}) {
  const [filters, setFilters] = React.useState<Filters>(() => {
    const query = new URLSearchParams(location.hash.split("?")[1]);
    return Object.fromEntries(
      fields.map((key) => [key, query.get(key) ?? ""]),
    ) as Filters;
  });
  const [draft, setDraft] = React.useState(() => draftFilters(filters));
  const [advanced, setAdvanced] = React.useState(
    !!(filters.requestId || filters.method || filters.from || filters.to),
  );
  const [message, setMessage] = React.useState("");
  const [page, setPage] = React.useState(1),
    [size, setSize] = React.useState(20);
  const users = useLoad<any[]>(() =>
    client.request("/api/plugins/official.users/users"),
  );
  const applied = new URLSearchParams(
    Object.entries(filters).filter(([, value]) => value),
  );
  const query = new URLSearchParams({
    ...Object.fromEntries(applied),
    limit: String(size),
    offset: String((page - 1) * size),
  });
  const rows = useLoad<any>(
    async () => ({
      ...(await client.request<any>("/api/host/audit?" + query)),
      query: query.toString(),
    }),
    [query.toString()],
  );
  const visible =
    rows.data?.query === query.toString() && !rows.error
      ? rows.data
      : undefined;
  React.useEffect(() => {
    const url = new URL(location.href);
    url.hash = "/audit" + (applied.size ? "?" + applied : "");
    history.replaceState(history.state, "", url);
  }, [applied.toString()]);
  const update = (key: keyof Filters, value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const active =
    Object.values(filters).some(Boolean) || Object.values(draft).some(Boolean);
  const name = (id: string) =>
    users.data?.find((u) => u.id === id)?.username ?? id ?? "—";
  return (
    <>
      <PageHeading title={tr("管理操作记录")}>
        <button className="secondary" onClick={rows.reload}>
          <Icon name="refresh" size={15} />
          {tr("刷新记录")}
        </button>
      </PageHeading>
      {navigation}
      <Notice message={message || rows.error || users.error} />
      {!!visible?.writeFailures && (
        <Notice
          message={tr("本进程审计写入失败 {0} 次，请核对相关管理操作。", {
            "0": String(visible.writeFailures),
          })}
        />
      )}
      {!!visible?.unresolved && (
        <Notice
          message={tr("有 {0} 条管理操作超过五分钟仍无最终结果。", {
            "0": String(visible.unresolved),
          })}
        />
      )}
      <form
        className="list-toolbar audit-filters"
        onSubmit={(event) => {
          event.preventDefault();
          const next = Object.fromEntries(
            Object.entries(draft).map(([key, value]) => [key, value.trim()]),
          ) as Filters;
          for (const key of ["from", "to"] as const) {
            if (!next[key]) continue;
            const time = new Date(next[key]).getTime();
            if (!Number.isFinite(time)) {
              setMessage("请输入有效的时间范围。");
              return;
            }
            next[key] = String(time);
          }
          if (next.from && next.to && Number(next.from) > Number(next.to)) {
            setMessage("开始时间不能晚于结束时间。");
            return;
          }
          setMessage("");
          setFilters(next);
          setPage(1);
        }}
      >
        <input
          type="search"
          aria-label={tr("搜索管理操作")}
          placeholder={tr("搜索操作路径或资源 ID")}
          maxLength={256}
          value={draft.q}
          onChange={(e) => update("q", e.target.value)}
        />
        <Select
          aria-label={tr("操作结果")}
          value={draft.result}
          onChange={(e) => update("result", e.target.value)}
        >
          <option value="">{tr("全部结果")}</option>
          <option value="success">{tr("成功")}</option>
          <option value="failure">{tr("失败")}</option>
          <option value="pending">{tr("结果待核查")}</option>
        </Select>
        <Select
          aria-label={tr("操作人")}
          value={draft.actorId}
          onChange={(e) => update("actorId", e.target.value)}
        >
          <option value="">{tr("全部操作人")}</option>
          {users.data?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.username}
            </option>
          ))}
        </Select>
        <Select
          aria-label={tr("目标用户")}
          value={draft.userId}
          onChange={(e) => update("userId", e.target.value)}
        >
          <option value="">{tr("全部目标用户")}</option>
          {users.data?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.username}
            </option>
          ))}
        </Select>
        <div className="actions">
          <button>{tr("筛选")}</button>
          <button
            type="button"
            className="secondary"
            aria-expanded={advanced}
            onClick={() => setAdvanced((value) => !value)}
          >
            {tr("更多筛选")}
          </button>
          {active && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setDraft({ ...empty });
                setFilters({ ...empty });
                setPage(1);
                setMessage("");
              }}
            >
              {tr("清除筛选")}
            </button>
          )}
        </div>
        {advanced && (
          <div className="form-grid audit-advanced">
            <label>
              {tr("请求 ID")}
              <input
                value={draft.requestId}
                maxLength={128}
                onChange={(e) => update("requestId", e.target.value)}
              />
            </label>
            <label>
              {tr("请求方法")}
              <Select
                value={draft.method}
                onChange={(e) => update("method", e.target.value)}
              >
                <option value="">{tr("全部方法")}</option>
                {["POST", "PUT", "PATCH", "DELETE"].map((method) => (
                  <option key={method} value={method}>
                    {method}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              {tr("开始时间")}
              <input
                type="datetime-local"
                value={draft.from}
                onChange={(e) => update("from", e.target.value)}
              />
            </label>
            <label>
              {tr("结束时间")}
              <input
                type="datetime-local"
                value={draft.to}
                onChange={(e) => update("to", e.target.value)}
              />
            </label>
          </div>
        )}
      </form>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{tr("时间 / 操作人")}</th>
              <th>{tr("操作 / 请求 ID")}</th>
              <th>{tr("目标")}</th>
              <th>{tr("原因")}</th>
              <th>{tr("结果")}</th>
            </tr>
          </thead>
          <tbody>
            {visible?.items.map((r: any) => (
              <tr key={r.id}>
                <td>
                  {new Date(r.created_at).toLocaleString(getLocale())}
                  <small>{name(r.actor_id)}</small>
                </td>
                <td>
                  <strong title={r.method + " " + r.path}>
                    {auditAction(r.method, r.path)}
                  </strong>
                  <small>
                    <a
                      href={"#/logs?requestId=" + encodeURIComponent(r.id)}
                      title={r.id}
                    >
                      {r.id.slice(0, 8)}
                    </a>
                  </small>
                </td>
                <td>
                  {name(r.user_id)}
                  <small>{r.resource_id ?? ""}</small>
                </td>
                <td>{r.reason ?? "—"}</td>
                <td>
                  <span
                    className={
                      "badge " + (r.status && r.status < 400 ? "ready" : "")
                    }
                  >
                    {r.status === null
                      ? tr("处理中 / 结果待核查")
                      : r.status < 400
                        ? tr("成功")
                        : tr("失败")}
                  </span>
                  <small>
                    {r.status ?? ""} {r.error_code ?? ""}
                  </small>
                </td>
              </tr>
            ))}
            {!visible?.items.length && (
              <tr>
                <td colSpan={5} className="empty-inline">
                  {rows.error
                    ? tr("无法读取管理操作记录。")
                    : visible
                      ? tr("没有匹配的管理操作。")
                      : tr("正在加载…")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <ListPagination
        total={visible?.total ?? 0}
        page={page}
        size={size}
        setPage={setPage}
        setSize={(value) => {
          setSize(value);
          setPage(1);
        }}
      />
    </>
  );
}
