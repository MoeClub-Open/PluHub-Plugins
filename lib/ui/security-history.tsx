import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { t as tr, getLocale } from "./i18n.js";
import { Select } from "./select.js";
import { PageHeading, ListPagination, Icon } from "./components.js";
import { Notice, useLoad } from "./mount.js";

const actionLabels: Record<string, string> = {
  login: "登录",
  logout: "退出登录",
  register: "注册账号",
  "identity.confirm": "确认身份",
  "password.change": "修改登录密码",
  "password.reset": "找回密码",
  "password.admin_reset": "维护重置密码",
  "email.bind": "绑定邮箱",
  "totp.enable": "启用 TOTP",
  "totp.disable": "停用 TOTP",
  "recovery.rotate": "重新生成恢复码",
  "passkey.register": "添加 Passkey",
  "passkey.remove": "移除 Passkey",
  "session.revoke": "退出登录设备",
  "session.revoke_others": "退出其他设备",
  "session.revoke_all": "撤销全部会话",
  "key.create": "创建 API Key",
  "key.update": "修改 API Key",
  "key.copy": "复制 API Key",
  "key.rotate": "重新生成 API Key",
  "key.binding": "修改密钥绑定",
  "key.revoke": "撤销 API Key",
  "account.create": "创建用户",
  "factors.reset": "重置验证方式",
  "account.bootstrap": "初始化或恢复管理员",
};
const methodLabels: Record<string, string> = {
  password: "密码",
  email: "邮箱验证码",
  totp: "TOTP",
  recovery: "恢复码",
  passkey: "Passkey",
  session: "登录会话",
  internal: "本地维护",
};
const outcomeLabels: Record<string, string> = {
  success: "成功",
  failure: "失败",
  challenge: "等待二步验证",
};
const keys = [
  "action",
  "outcome",
  "method",
  "userId",
  "actorId",
  "requestId",
  "from",
  "to",
] as const;
type Filters = Record<(typeof keys)[number], string>;
const empty = Object.fromEntries(keys.map((key) => [key, ""])) as Filters;
const localDate = (value: string) => {
  const date = new Date(Number(value));
  return value && Number.isFinite(date.getTime())
    ? new Date(date.getTime() - date.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16)
    : "";
};
export function SecurityHistory({
  host,
  administrative = false,
  navigation,
}: {
  host: UIHost;
  administrative?: boolean;
  navigation?: React.ReactNode;
}) {
  const [filters, setFilters] = React.useState<Filters>(() => {
    const query = new URLSearchParams(location.hash.split("?")[1]);
    return Object.fromEntries(
      keys.map((key) => [
        key,
        administrative || !["userId", "actorId"].includes(key)
          ? (query.get(key) ?? "")
          : "",
      ]),
    ) as Filters;
  });
  const [draft, setDraft] = React.useState(() => ({
    ...filters,
    from: localDate(filters.from),
    to: localDate(filters.to),
  }));
  const [advanced, setAdvanced] = React.useState(
    !!(
      filters.from ||
      filters.to ||
      filters.requestId ||
      filters.actorId ||
      filters.userId
    ),
  );
  const [message, setMessage] = React.useState("");
  const [page, setPage] = React.useState(1),
    [size, setSize] = React.useState(20);
  const applied = new URLSearchParams(
    Object.entries(filters).filter(([, value]) => value),
  );
  const query = new URLSearchParams({
    ...Object.fromEntries(applied),
    limit: String(size),
    offset: String((page - 1) * size),
  });
  const endpoint =
    "/api/plugins/official.auth/" +
    (administrative ? "admin/security-history" : "security/history");
  const rows = useLoad<any>(
    async () => ({
      ...(await host.request<any>(endpoint + "?" + query)),
      query: query.toString(),
    }),
    [query.toString(), endpoint],
  );
  const users = useLoad<any[]>(
    () =>
      administrative
        ? host.request("/api/plugins/official.users/users")
        : Promise.resolve([]),
    [administrative],
  );
  const visible =
    rows.data?.query === query.toString() && !rows.error
      ? rows.data
      : undefined;
  const name = (id: string | null) =>
    id ? (users.data?.find((user) => user.id === id)?.username ?? id) : "—";
  const update = (key: keyof Filters, value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));
  React.useEffect(() => {
    const url = new URL(location.href),
      params = new URLSearchParams(applied);
    params.set(
      administrative ? "view" : "tab",
      administrative ? "security" : "history",
    );
    url.hash = (administrative ? "/audit" : "/account") + "?" + params;
    history.replaceState(history.state, "", url);
  }, [applied.toString(), administrative]);
  const content = (
    <>
      <Notice message={message || rows.error || users.error} />
      {!!visible?.storage?.dropped && (
        <Notice
          message={tr("有 {0} 条安全记录未能保存，请联系管理员检查。", {
            "0": String(visible.storage.dropped),
          })}
        />
      )}
      <form
        className="list-toolbar security-history-filters"
        onSubmit={(event) => {
          event.preventDefault();
          const next = Object.fromEntries(
            Object.entries(draft).map(([key, value]) => [key, value.trim()]),
          ) as Filters;
          for (const key of ["from", "to"] as const) {
            if (!next[key]) continue;
            const value = new Date(next[key]).getTime();
            if (!Number.isFinite(value)) {
              setMessage("请输入有效的时间范围。");
              return;
            }
            next[key] = String(value);
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
        <Select
          aria-label={tr("安全事件")}
          value={draft.action}
          onChange={(e) => update("action", e.target.value)}
        >
          <option value="">{tr("全部事件")}</option>
          {Object.entries(actionLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {tr(label)}
            </option>
          ))}
        </Select>
        <Select
          aria-label={tr("操作结果")}
          value={draft.outcome}
          onChange={(e) => update("outcome", e.target.value)}
        >
          <option value="">{tr("全部结果")}</option>
          {Object.entries(outcomeLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {tr(label)}
            </option>
          ))}
        </Select>
        <Select
          aria-label={tr("验证方式")}
          value={draft.method}
          onChange={(e) => update("method", e.target.value)}
        >
          <option value="">{tr("全部验证方式")}</option>
          {Object.entries(methodLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {tr(label)}
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
          {Object.values(filters).some(Boolean) && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setFilters({ ...empty });
                setDraft({ ...empty });
                setPage(1);
                setMessage("");
              }}
            >
              {tr("清除筛选")}
            </button>
          )}
        </div>
        {advanced && (
          <div className="form-grid security-history-advanced">
            {administrative && (
              <>
                <label>
                  {tr("目标用户")}
                  <Select
                    value={draft.userId}
                    onChange={(e) => update("userId", e.target.value)}
                  >
                    <option value="">{tr("全部目标用户")}</option>
                    {users.data?.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.username}
                      </option>
                    ))}
                  </Select>
                </label>
                <label>
                  {tr("操作人")}
                  <Select
                    value={draft.actorId}
                    onChange={(e) => update("actorId", e.target.value)}
                  >
                    <option value="">{tr("全部操作人")}</option>
                    {users.data?.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.username}
                      </option>
                    ))}
                  </Select>
                </label>
              </>
            )}
            <label>
              {tr("请求 ID")}
              <input
                value={draft.requestId}
                maxLength={128}
                onChange={(e) => update("requestId", e.target.value)}
              />
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
              <th>{tr("时间")}</th>
              <th>{tr("安全事件")}</th>
              {administrative && <th>{tr("目标 / 操作人")}</th>}
              <th>{tr("验证方式")}</th>
              <th>{tr("设备 / 来源")}</th>
              <th>{tr("结果")}</th>
            </tr>
          </thead>
          <tbody>
            {visible?.items.map((row: any) => (
              <tr key={row.id}>
                <td>{new Date(row.created_at).toLocaleString(getLocale())}</td>
                <td>
                  {tr(actionLabels[row.action] ?? row.action)}
                  {row.request_id && (
                    <small>
                      {administrative ? (
                        <a
                          href={
                            "#/logs?requestId=" +
                            encodeURIComponent(row.request_id)
                          }
                          title={row.request_id}
                        >
                          {row.request_id.slice(0, 8)}
                        </a>
                      ) : (
                        <code title={row.request_id}>
                          {row.request_id.slice(0, 8)}
                        </code>
                      )}
                    </small>
                  )}
                  {row.other_actor && <small>{tr("其他账号操作")}</small>}
                </td>
                {administrative && (
                  <td>
                    {name(row.user_id)}
                    <small>{name(row.actor_id)}</small>
                  </td>
                )}
                <td>{tr(methodLabels[row.method] ?? row.method)}</td>
                <td>
                  {row.device || "—"}
                  <small>{row.ip || "—"}</small>
                </td>
                <td>
                  <span
                    className={
                      "badge " +
                      (row.outcome === "success"
                        ? "ready"
                        : row.outcome === "failure"
                          ? "error"
                          : "")
                    }
                  >
                    {tr(outcomeLabels[row.outcome] ?? row.outcome)}
                  </span>
                  {row.error_code && (
                    <small>
                      <code>{row.error_code}</code>
                    </small>
                  )}
                </td>
              </tr>
            ))}
            {!visible?.items.length && (
              <tr>
                <td colSpan={administrative ? 6 : 5} className="empty-inline">
                  {rows.error
                    ? tr("无法读取安全记录。")
                    : visible
                      ? tr("没有匹配的安全记录。")
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
  return (
    <>
      {administrative ? (
        <PageHeading title={tr("账号安全记录")}>
          <button className="secondary" onClick={rows.reload}>
            <Icon name="refresh" size={15} />
            {tr("刷新记录")}
          </button>
        </PageHeading>
      ) : (
        <div className="page-heading">
          <h2>{tr("安全记录")}</h2>
          <button className="secondary" onClick={rows.reload}>
            <Icon name="refresh" size={15} />
            {tr("刷新记录")}
          </button>
        </div>
      )}
      {navigation}
      {content}
    </>
  );
}
