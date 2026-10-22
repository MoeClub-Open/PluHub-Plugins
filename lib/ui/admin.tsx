import { t as tr, getLocale } from "./i18n.js";
import { Select } from "./select.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { useLoad, Notice } from "./mount.js";
import { PageHeading, Dialog, ListPagination, Icon } from "./components.js";
export function AdminConfirm({
  title,
  description,
  close,
  submit,
  children,
}: {
  title: string;
  description: string;
  close: () => void;
  submit: (reason: string, fields: FormData) => Promise<void>;
  children?: React.ReactNode;
}) {
  const [message, setMessage] = React.useState(""),
    [busy, setBusy] = React.useState(false);
  return (
    <Dialog
      title={title}
      close={() => {
        if (!busy) close();
      }}
    >
      <Notice message={message} />
      <p>{description}</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const fields = new FormData(e.currentTarget);
          setBusy(true);
          try {
            await submit(String(fields.get("reason")), fields);
            close();
          } catch (error) {
            setMessage((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {children}
        <label>
          {tr("操作原因")}
          <input name="reason" required maxLength={256} autoComplete="off" />
        </label>
        <div className="form-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={close}
          >
            {tr("取消")}
          </button>
          <button className="danger" disabled={busy}>
            {busy ? tr("处理中…") : tr("确认操作")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
type Column = { title: string; render: (row: any) => React.ReactNode };
export function AdminTable({
  host,
  title,
  description,
  endpoint,
  columns,
  statuses = {},
  actions,
  children,
  version = 0,
  embedded = false,
}: {
  host: UIHost;
  title: string;
  description?: string;
  endpoint: string;
  columns: Column[];
  statuses?: Record<string, string>;
  actions?: (row: any, reload: () => void) => React.ReactNode;
  children?: React.ReactNode;
  version?: number;
  embedded?: boolean;
}) {
  const users = useLoad<any[]>(() =>
    host.request("/api/plugins/official.users/users"),
  );
  const [user, setUser] = React.useState(
      new URLSearchParams(location.hash.split("?")[1]).get("userId") ?? "",
    ),
    [q, setQ] = React.useState(""),
    [status, setStatus] = React.useState("");
  const [page, setPage] = React.useState(1),
    [size, setSize] = React.useState(20);
  const query = new URLSearchParams({
    userId: user,
    q,
    status,
    limit: String(size),
    offset: String((page - 1) * size),
  });
  const data = useLoad<any>(
    () => host.request(endpoint + "?" + query),
    [user, q, status, page, size, version],
  );
  React.useEffect(() => {
    if (data.data)
      setPage((current) =>
        Math.min(current, Math.max(1, Math.ceil(data.data.total / size))),
      );
  }, [data.data, size]);
  const username = (id: string) =>
    users.data?.find((u) => u.id === id)?.username ?? id ?? "—";
  return (
    <>
      {embedded ? (
        <div className="section-heading">
          <div>
            <h2>{title}</h2>
            {description && <p className="muted">{description}</p>}
          </div>
          <button
            className="secondary"
            aria-label={tr("刷新管理列表")}
            onClick={data.reload}
          >
            <Icon name="refresh" size={15} />
          </button>
        </div>
      ) : (
        <PageHeading title={title} description={description}>
          <button
            className="secondary"
            aria-label={tr("刷新管理列表")}
            onClick={data.reload}
          >
            <Icon name="refresh" size={15} />
          </button>
          {children}
        </PageHeading>
      )}
      <Notice message={data.error || users.error} />
      <div className="list-toolbar">
        <input
          type="search"
          aria-label={tr("搜索管理记录")}
          placeholder={tr("搜索名称、前缀或记录 ID")}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
        <Select
          aria-label={tr("管理列表用户")}
          value={user}
          onChange={(e) => {
            setUser(e.target.value);
            setPage(1);
          }}
        >
          <option value="">{tr("全部用户")}</option>
          {users.data?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.username}
            </option>
          ))}
        </Select>
        {!!Object.keys(statuses).length && (
          <Select
            aria-label={tr("管理记录状态")}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">{tr("全部状态")}</option>
            {Object.entries(statuses).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </Select>
        )}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{tr("用户")}</th>
              {columns.map((column) => (
                <th key={column.title}>{column.title}</th>
              ))}
              {actions && <th>{tr("操作")}</th>}
            </tr>
          </thead>
          <tbody>
            {data.data?.items.map((row: any) => (
              <tr key={row.id ?? row.source}>
                <td>
                  <strong>{username(row.user_id)}</strong>
                </td>
                {columns.map((column) => (
                  <td key={column.title}>{column.render(row)}</td>
                ))}
                {actions && <td>{actions(row, data.reload)}</td>}
              </tr>
            ))}
            {!data.data?.items.length && (
              <tr>
                <td
                  colSpan={columns.length + (actions ? 2 : 1)}
                  className="empty-inline"
                >
                  {data.data
                    ? tr("没有匹配的管理记录。")
                    : data.error
                      ? tr("加载失败，请刷新重试。")
                      : tr("正在加载…")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <ListPagination
        total={data.data?.total ?? 0}
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
export const adminTime = (value?: number | string) =>
  value ? new Date(value).toLocaleString(getLocale()) : "—";
