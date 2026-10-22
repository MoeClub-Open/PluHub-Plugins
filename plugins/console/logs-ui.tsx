import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { t as tr, getLocale } from "../../lib/ui/i18n.js";
import { Select } from "../../lib/ui/select.js";
import { useLoad, Notice } from "../../lib/ui/mount.js";
import {
  PageHeading,
  ListPagination,
  Icon,
  Dialog,
} from "../../lib/ui/components.js";

type Entry = {
  id: string;
  time: number;
  plugin: string;
  level: string;
  message: string;
  requestId?: string;
  method?: string;
  path?: string;
  status?: number;
  code?: string;
  durationMs?: number;
  graphVersion?: number;
};
export function RuntimeLogs({ client }: { client: UIHost }) {
  const [level, setLevel] = React.useState("");
  const [plugin, setPlugin] = React.useState("");
  const [hours, setHours] = React.useState(24);
  const [requestId, setRequestId] = React.useState(
    new URLSearchParams(location.hash.split("?")[1]).get("requestId") ?? "",
  );
  const [q, setQ] = React.useState("");
  const [filters, setFilters] = React.useState({ q: "", requestId });
  const [page, setPage] = React.useState(1),
    [size, setSize] = React.useState(20);
  const [selected, setSelected] = React.useState<Entry>();
  const [copied, setCopied] = React.useState(false),
    [copyError, setCopyError] = React.useState("");
  const plugins = useLoad<{ id: string; name: string }[]>(() =>
    client.request("/api/host/plugins"),
  );
  const rows = useLoad<{
    items: Entry[];
    total: number;
    dropped: number;
    failures: number;
  }>(() => {
    const query = new URLSearchParams({
      level,
      plugin,
      ...filters,
      from: String(Date.now() - hours * 3600000),
      limit: String(size),
      offset: String((page - 1) * size),
    });
    return client.request("/api/host/logs?" + query);
  }, [level, plugin, hours, filters, page, size]);
  const pluginName = (id: string) =>
    id === "host"
      ? tr("宿主")
      : (plugins.data?.find((p) => p.id === id)?.name ?? id);
  const levels: Record<string, string> = {
    info: tr("信息"),
    warn: tr("警告"),
    error: tr("错误"),
  };
  return (
    <>
      <PageHeading title={tr("运行日志")}>
        <button className="secondary" onClick={rows.reload}>
          <Icon name="refresh" size={16} />
          {tr("刷新")}
        </button>
      </PageHeading>
      <Notice message={rows.error || plugins.error || copyError} />
      {!!rows.data?.dropped && (
        <div className="notice" role="status">
          {tr("日志写入失败 {0} 条", { "0": String(rows.data.dropped) })}
        </div>
      )}
      <form
        className="list-toolbar runtime-log-filters"
        onSubmit={(e) => {
          e.preventDefault();
          setFilters({ q: q.trim(), requestId: requestId.trim() });
          setPage(1);
        }}
      >
        <input
          type="search"
          aria-label={tr("搜索运行日志")}
          placeholder={tr("搜索消息、路径或错误代码")}
          value={q}
          maxLength={256}
          onChange={(e) => setQ(e.target.value)}
        />
        <input
          aria-label={tr("请求 ID")}
          placeholder={tr("请求 ID")}
          value={requestId}
          maxLength={256}
          onChange={(e) => setRequestId(e.target.value)}
        />
        <Select
          aria-label={tr("日志级别")}
          value={level}
          onChange={(e) => {
            setLevel(e.target.value);
            setPage(1);
          }}
        >
          <option value="">{tr("全部级别")}</option>
          {Object.entries(levels).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </Select>
        <Select
          aria-label={tr("插件")}
          value={plugin}
          onChange={(e) => {
            setPlugin(e.target.value);
            setPage(1);
          }}
        >
          <option value="">{tr("全部插件")}</option>
          <option value="host">{tr("宿主")}</option>
          {plugins.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label={tr("日志时间范围")}
          value={hours}
          onChange={(e) => {
            setHours(Number(e.target.value));
            setPage(1);
          }}
        >
          <option value="24">{tr("最近 24 小时")}</option>
          <option value="168">{tr("最近 7 天")}</option>
          <option value="720">{tr("最近 30 天")}</option>
        </Select>
        <button className="secondary">{tr("筛选")}</button>
      </form>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {["时间", "日志级别", "插件", "消息", "请求", "详情"].map(
                (label) => (
                  <th key={label}>{tr(label)}</th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {rows.data?.items.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.time).toLocaleString(getLocale())}</td>
                <td>
                  <span
                    className={"badge " + (r.level === "error" ? "error" : "")}
                  >
                    {levels[r.level]}
                  </span>
                </td>
                <td>{pluginName(r.plugin)}</td>
                <td>
                  <span className="runtime-log-message">{r.message}</span>
                  {r.code && <small>{r.code}</small>}
                </td>
                <td>
                  <code>
                    {r.method} {r.path}
                  </code>
                  {r.requestId && (
                    <small>
                      <code>{r.requestId.slice(0, 8)}</code>
                      {r.status ? " · " + r.status : ""}
                    </small>
                  )}
                </td>
                <td>
                  <button
                    className="ghost"
                    onClick={() => {
                      setSelected(r);
                      setCopied(false);
                      setCopyError("");
                    }}
                  >
                    {tr("详情")}
                  </button>
                </td>
              </tr>
            ))}
            {!rows.data?.items.length && (
              <tr>
                <td colSpan={6} className="empty-inline">
                  {rows.data ? tr("没有匹配的日志") : tr("正在加载…")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <ListPagination
        total={rows.data?.total ?? 0}
        page={page}
        size={size}
        setPage={setPage}
        setSize={(value) => {
          setSize(value);
          setPage(1);
        }}
      />
      {selected && (
        <Dialog title={tr("日志详情")} close={() => setSelected(undefined)}>
          <dl className="detail-grid">
            {Object.entries({
              "请求 ID": selected.requestId,
              时间: new Date(selected.time).toLocaleString(getLocale()),
              插件: selected.plugin,
              日志级别: levels[selected.level],
              路径: selected.path,
              "HTTP 状态": selected.status,
              错误代码: selected.code,
              "耗时 (ms)": selected.durationMs,
              执行图版本: selected.graphVersion,
            }).map(([key, value]) => (
              <div key={key}>
                <dt>{tr(key)}</dt>
                <dd>{value ?? "—"}</dd>
              </div>
            ))}
          </dl>
          <pre className="runtime-log-detail">{selected.message}</pre>
          <div className="actions">
            <button
              className="secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(
                    JSON.stringify(selected, null, 2),
                  );
                  setCopied(true);
                } catch {
                  setCopyError(tr("复制失败"));
                }
              }}
            >
              <Icon name="copy" size={14} />
              {copied ? tr("已复制") : tr("复制")}
            </button>
            {selected.requestId && (
              <button
                className="secondary"
                onClick={() => {
                  setRequestId(selected.requestId!);
                  setFilters({ q: "", requestId: selected.requestId! });
                  setQ("");
                  setLevel("");
                  setPlugin("");
                  setPage(1);
                  setSelected(undefined);
                }}
              >
                {tr("关联日志")}
              </button>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
