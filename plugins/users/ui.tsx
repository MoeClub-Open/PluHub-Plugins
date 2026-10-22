import { t as tr, textValue, getLocale } from "../../lib/ui/i18n.js";
import { Select } from "../../lib/ui/select.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { UserDetail } from "./detail-ui.js";
import { mountPage, useLoad, Notice } from "../../lib/ui/mount.js";
import {
  PageHeading,
  Dialog,
  Icon,
  ListPagination,
} from "../../lib/ui/components.js";
const api = "/api/plugins/official.users/users";
function Page({ host }: { host: UIHost }) {
  const users = useLoad<any[]>(() => host.request(api));
  const me = useLoad<any>(() => host.request("/api/plugins/official.auth/me"));
  const [message, setMessage] = React.useState("");
  const [query, setQuery] = React.useState(""),
    [role, setRole] = React.useState("all"),
    [status, setStatus] = React.useState("all");
  const [page, setPage] = React.useState(1),
    [size, setSize] = React.useState(10);
  const [createOpen, setCreateOpen] = React.useState(false),
    [target, setTarget] = React.useState<any>();
  const [busy, setBusy] = React.useState(false);
  const [detail, setDetail] = React.useState<any>();
  const rows = (users.data ?? []).filter(
    (user) =>
      user.username.toLowerCase().includes(query.toLowerCase().trim()) &&
      (role === "all" || user.role === role) &&
      (status === "all" || user.enabled === (status === "enabled")),
  );
  const current = Math.min(page, Math.max(1, Math.ceil(rows.length / size)));
  return (
    <>
      <PageHeading title={tr("用户管理")}>
        <button
          className="secondary"
          aria-label={tr("刷新用户")}
          title={tr("刷新用户")}
          onClick={users.reload}
        >
          <Icon name="refresh" size={15} />
        </button>
        <button
          onClick={() => {
            setMessage("");
            setCreateOpen(true);
          }}
        >
          <Icon name="plus" size={15} />
          {tr("创建用户")}
        </button>
      </PageHeading>
      {!createOpen && !target && !detail && (
        <Notice message={message || users.error} />
      )}
      <div className="list-toolbar">
        <input
          type="search"
          aria-label={tr("搜索用户")}
          placeholder={tr("搜索用户名")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
        />
        <Select
          aria-label={tr("筛选管理员权限")}
          value={role}
          onChange={(e) => {
            setRole(e.target.value);
            setPage(1);
          }}
        >
          <option value="all">{tr("全部用户")}</option>
          <option value="admin">{tr("管理员")}</option>
          <option value="user">{tr("非管理员")}</option>
        </Select>
        <Select
          aria-label={tr("筛选用户状态")}
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="all">{tr("全部状态")}</option>
          <option value="enabled">{tr("启用")}</option>
          <option value="disabled">{tr("禁用")}</option>
        </Select>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{tr("用户名")}</th>
              <th>{tr("身份")}</th>
              <th>{tr("状态")}</th>
              <th>{tr("创建时间")}</th>
              <th>{tr("操作")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice((current - 1) * size, current * size).map((user) => (
              <tr key={user.id}>
                <td>
                  <strong>{user.username}</strong>
                  {user.id === me.data?.id && <small>{tr("当前账号")}</small>}
                </td>
                <td>{user.role === "admin" ? tr("管理员") : tr("非管理员")}</td>
                <td>
                  <span className={"badge " + (user.enabled ? "ready" : "")}>
                    {user.enabled ? tr("启用") : tr("禁用")}
                  </span>
                </td>
                <td>{new Date(user.createdAt).toLocaleString(getLocale())}</td>
                <td>
                  <button className="ghost" onClick={() => setDetail(user)}>
                    {tr("详情")}
                  </button>
                  <button
                    className={"ghost " + (user.enabled ? "danger" : "")}
                    disabled={busy || user.id === me.data?.id}
                    title={
                      user.id === me.data?.id
                        ? tr("不能在此禁用自己的账号")
                        : undefined
                    }
                    onClick={() => {
                      setMessage("");
                      setTarget(user);
                    }}
                  >
                    {user.enabled ? tr("禁用") : tr("启用")}
                  </button>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={5} className="empty-inline">
                  {users.data
                    ? tr("没有匹配的用户，可调整筛选条件。")
                    : users.error
                      ? tr("用户加载失败，请刷新重试。")
                      : tr("正在加载用户…")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <ListPagination
        total={rows.length}
        page={current}
        size={size}
        setPage={setPage}
        setSize={setSize}
      />
      {createOpen && (
        <Dialog
          title={tr("创建用户")}
          close={() => {
            if (!busy) setCreateOpen(false);
          }}
        >
          <Notice message={message} />
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const form = e.currentTarget,
                data = Object.fromEntries(new FormData(form));
              data.role = data.isAdmin === "on" ? "admin" : "user";
              delete data.isAdmin;
              setBusy(true);
              setMessage("");
              try {
                await host.request("/api/plugins/official.auth/users", {
                  method: "POST",
                  body: JSON.stringify(data),
                });
                setCreateOpen(false);
                users.reload();
                setMessage(tr("用户及初始密码已创建。"));
              } catch (error) {
                setMessage((error as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              {tr("用户名")}
              <input
                name="username"
                required
                minLength={3}
                maxLength={64}
                pattern="[a-zA-Z0-9][a-zA-Z0-9_.\-]{2,63}"
                autoFocus
                disabled={busy}
              />
            </label>
            <label>
              {tr("初始密码")}
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={1024}
                disabled={busy}
              />
            </label>
            <label className="checkbox">
              <input name="isAdmin" type="checkbox" disabled={busy} />
              {tr("管理员")}
            </label>
            <div className="form-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setCreateOpen(false)}
              >
                {tr("取消")}
              </button>
              <button disabled={busy}>
                {busy ? tr("创建中…") : tr("创建用户")}
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {target && (
        <Dialog
          title={(target.enabled ? tr("禁用") : tr("启用")) + tr("用户")}
          close={() => {
            if (!busy) setTarget(undefined);
          }}
        >
          <Notice message={message} />
          <p>
            {target.enabled
              ? tr("禁用「{0}」后，该用户的登录会话和 API 密钥将无法使用。", {
                  "0": textValue(target.username),
                })
              : tr("启用「{0}」后，该用户可以恢复登录和 API 调用。", {
                  "0": textValue(target.username),
                })}
          </p>
          <div className="form-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setTarget(undefined)}
            >
              {tr("取消")}
            </button>
            <button
              className={target.enabled ? "danger" : ""}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await host.request(api, {
                    method: "PATCH",
                    body: JSON.stringify({
                      id: target.id,
                      enabled: !target.enabled,
                    }),
                  });
                  setTarget(undefined);
                  users.reload();
                  setMessage(tr("用户状态已更新。"));
                } catch (error) {
                  setMessage((error as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy
                ? tr("处理中…")
                : target.enabled
                  ? tr("确认禁用")
                  : tr("确认启用")}
            </button>
          </div>
        </Dialog>
      )}
      {detail && (
        <UserDetail
          host={host}
          user={detail}
          self={detail.id === me.data?.id}
          close={() => setDetail(undefined)}
          updated={users.reload}
        />
      )}
    </>
  );
}
export const mount = (element: HTMLElement, host: UIHost) =>
  mountPage(element, host, Page);
