import { t as tr, textValue, getLocale } from "../../lib/ui/i18n.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { useLoad, Notice } from "../../lib/ui/mount.js";
import { Icon, PageHeading, Stat } from "../../lib/ui/components.js";
interface HostStatus {
  time: string;
  status: "running" | "degraded";
  runtime: {
    node: string;
    platform: string;
    arch: string;
    uptimeSeconds: number;
  };
  memory: { rss: number; heapUsed: number; heapTotal: number };
  graphVersion: number;
  plugins: { total: number; active: number; failed: number; stopped: number };
  audit?: {
    available: boolean;
    writeFailures: number;
    unresolved: number | null;
  };
  storage?: {
    available: boolean;
    totalBytes: number | null;
    availableBytes: number | null;
    lowSpace: boolean | null;
  };
}
const bytes = (value?: number) =>
  value === undefined ? "—" : (value / 1024 / 1024).toFixed(1) + " MiB";
const diskBytes = (value: number | null | undefined) =>
  value == null ? "—" : (value / 1024 ** 3).toFixed(1) + " GiB";
const duration = (seconds?: number) =>
  seconds === undefined
    ? "—"
    : seconds < 60
      ? tr("{0} 秒", { "0": textValue(seconds) })
      : seconds < 3600
        ? tr("{0} 分钟", { "0": textValue(Math.floor(seconds / 60)) })
        : seconds < 86400
          ? tr("{0} 小时 {1} 分", {
              "0": textValue(Math.floor(seconds / 3600)),
              "1": textValue(Math.floor((seconds % 3600) / 60)),
            })
          : tr("{0} 天 {1} 小时", {
              "0": textValue(Math.floor(seconds / 86400)),
              "1": textValue(Math.floor((seconds % 86400) / 3600)),
            });
export function SystemStatus({ client }: { client: UIHost }) {
  const data = useLoad(async () => {
    const [host, health, ready, plugins] = await Promise.allSettled([
      client.request<HostStatus>("/api/host/status"),
      client.request<{ status: string }>("/healthz"),
      client.request<{ status: string }>("/readyz"),
      client.request<
        { id: string; state: string; manifest?: { provides?: string[] } }[]
      >("/api/host/plugins"),
    ]);
    if (host.status === "rejected") throw host.reason;
    const observation =
      plugins.status === "fulfilled" &&
      plugins.value.some(
        (plugin) =>
          plugin.id === "official.observability" && plugin.state === "Active",
      )
        ? await client
            .request<{ available: boolean; dropped: number; failures: number }>(
              "/api/plugins/official.observability/status",
            )
            .catch(() => ({ available: false, dropped: 0, failures: 0 }))
        : undefined;
    const securityHistory =
      plugins.status === "fulfilled" &&
      plugins.value.some(
        (plugin) =>
          plugin.id === "official.auth" &&
          plugin.state === "Active" &&
          plugin.manifest?.provides?.includes("auth.security-history@1"),
      )
        ? await client
            .request<{ available: boolean; dropped: number; failures: number }>(
              "/api/plugins/official.auth/admin/security-history/status",
            )
            .catch(() => ({ available: false, dropped: 0, failures: 0 }))
        : undefined;
    return {
      host: host.value,
      health: health.status === "fulfilled" ? health.value.status : undefined,
      ready: ready.status === "fulfilled" ? ready.value.status : undefined,
      observation,
      securityHistory,
    };
  });
  React.useEffect(() => {
    const timer = setInterval(data.reload, 30000);
    return () => clearInterval(timer);
  }, []);
  const s = data.data?.host;
  return (
    <>
      <PageHeading title={tr("系统状态")}>
        <button className="secondary" onClick={data.reload}>
          <Icon name="refresh" size={15} />
          {tr("刷新状态")}
        </button>
        <a className="button secondary" href="#/plugins">
          {tr("插件管理")}
        </a>
      </PageHeading>
      <Notice message={data.error} />
      {data.data?.securityHistory &&
        (!data.data.securityHistory.available ||
          data.data.securityHistory.failures > 0) && (
          <div className="notice" role="status">
            {tr("账号安全记录需检查，本进程有 {0} 条记录未保存。", {
              "0": String(data.data.securityHistory.dropped),
            })}{" "}
            <a href="#/audit?view=security">{tr("查看安全记录")}</a>
          </div>
        )}
      {s?.storage && (!s.storage.available || s.storage.lowSpace) && (
        <Notice
          message={
            s.storage.available
              ? tr("数据盘剩余空间不足，请清理无用构建产物或扩容。")
              : tr("无法读取数据盘余量，请检查存储。")
          }
        />
      )}
      {s?.audit &&
        (!s.audit.available ||
          s.audit.writeFailures > 0 ||
          (s.audit.unresolved ?? 0) > 0) && (
          <div className="notice" role="status">
            {tr("管理审计需检查，请核对存储状态和未完成记录。")}{" "}
            <a href="#/audit?result=pending">{tr("查看管理记录")}</a>
          </div>
        )}
      {data.data?.observation &&
        (!data.data.observation.available ||
          data.data.observation.failures > 0) && (
          <Notice
            message={tr(
              "调用日志存储需检查，本进程有 {0} 条记录未保存。计费账本独立保存。",
              { "0": textValue(data.data.observation.dropped) },
            )}
          />
        )}
      <div className="stats four">
        <Stat
          title={tr("宿主状态")}
          value={
            s ? (s.status === "running" ? tr("运行中") : tr("需关注")) : "—"
          }
          note={
            s
              ? tr("{0} 个失败插件", { "0": textValue(s.plugins.failed) })
              : tr("正在读取状态")
          }
          icon="activity"
        />
        <Stat
          title={tr("插件运行")}
          value={s ? `${s.plugins.active} / ${s.plugins.total}` : "—"}
          note={
            s
              ? tr("{0} 个已停止", { "0": textValue(s.plugins.stopped) })
              : tr("当前宿主中的插件")
          }
          icon="plugins"
        />
        <Stat
          title={tr("进程内存")}
          value={bytes(s?.memory.rss)}
          note={tr("宿主 RSS")}
          icon="overview"
        />
        <Stat
          title={tr("连续运行")}
          value={duration(s?.runtime.uptimeSeconds)}
          note={tr("当前 Node.js 进程")}
          icon="clock"
        />
      </div>
      <section className="card">
        <h2>{tr("网关探针")}</h2>
        <div className="system-probes">
          {[
            {
              name: tr("存活检查"),
              value: data.data?.health,
              ok: data.data?.health === "ready",
            },
            {
              name: tr("就绪检查"),
              value: data.data?.ready,
              ok: data.data?.ready === "ready",
            },
            ...(s?.audit
              ? [
                  {
                    name: tr("管理审计存储"),
                    value: s.audit.available ? "ready" : "error",
                    ok: s.audit.available,
                  },
                ]
              : []),
          ].map((p) => (
            <div key={p.name}>
              <span>{p.name}</span>
              <strong className={"badge " + (p.ok ? "ready" : "")}>
                {p.value ? (p.ok ? tr("正常") : tr("未就绪")) : tr("暂不可用")}
              </strong>
            </div>
          ))}
        </div>
      </section>
      <section className="card">
        <h2>{tr("运行环境")}</h2>
        <div className="table-wrap">
          <table>
            <tbody>
              {[
                ["Node.js", s?.runtime.node],
                [
                  tr("平台 / 架构"),
                  s ? s.runtime.platform + " / " + s.runtime.arch : undefined,
                ],
                [tr("执行图版本"), s?.graphVersion],
                [
                  tr("数据盘可用 / 总容量"),
                  s?.storage?.available
                    ? diskBytes(s.storage.availableBytes) +
                      " / " +
                      diskBytes(s.storage.totalBytes)
                    : "—",
                ],
                [
                  tr("JavaScript 堆"),
                  s
                    ? bytes(s.memory.heapUsed) +
                      " / " +
                      bytes(s.memory.heapTotal)
                    : undefined,
                ],
                [
                  tr("最近更新"),
                  s ? new Date(s.time).toLocaleString(getLocale()) : undefined,
                ],
              ].map(([title, value]) => (
                <tr key={title}>
                  <th scope="row">{title}</th>
                  <td>{value ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
