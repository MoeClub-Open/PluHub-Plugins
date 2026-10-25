import { t as tr, textValue, getLocale } from "../../lib/ui/i18n.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { useLoad, Notice } from "../../lib/ui/mount.js";
import {
  ConsumptionBreakdown,
  TokenStat,
  walletNote,
} from "../../lib/ui/consumption.js";
import {
  PageHeading,
  Stat,
  RequestChart,
  Icon,
  number,
  latency,
  money,
  type Summary,
} from "../../lib/ui/components.js";
type RecentRequest = {
  id: string;
  model: string | null;
  status: "success" | "error" | "cancelled";
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: number;
  user_name: string | null;
  key_name: string | null;
  key_id: string | null;
  effort: string | null;
};
const outcome = {
  get success() {
    return tr("成功");
  },
  get error() {
    return tr("失败");
  },
  get cancelled() {
    return tr("已取消");
  },
};
export function Dashboard({
  client,
  management,
}: {
  client: UIHost;
  management: boolean;
}) {
  const [hours, setHours] = React.useState(24);
  const [copied, setCopied] = React.useState(false);
  const stats = useLoad<Summary>(
    () =>
      client.request(
        "/api/plugins/official.observability/summary?hours=" +
          hours +
          (management ? "" : "&scope=me"),
      ),
    [hours, management],
  );
  const models = useLoad<any[]>(
    () =>
      management
        ? Promise.resolve([])
        : client.request("/api/plugins/official.model-catalog/models"),
    [management],
  );
  const recent = useLoad<{ data: RecentRequest[]; total: number }>(
    () =>
      client.request(
        "/api/plugins/official.observability/requests?limit=5&hours=" +
          hours +
          (management ? "" : "&scope=me"),
      ),
    [hours, management],
  );
  function refresh() {
    stats.reload();
    recent.reload();
  }
  React.useEffect(() => {
    const timer = setInterval(refresh, 30000);
    return () => clearInterval(timer);
  }, []);
  const d = stats.data;
  const endpoint = location.origin + "/v1";
  return (
    <>
      <PageHeading title={management ? tr("全站总览") : tr("总览")}>
        <div
          className="dashboard-range"
          role="group"
          aria-label={tr("统计时间范围")}
        >
          {[
            [24, tr("24 小时")],
            [168, tr("7 天")],
            [720, tr("30 天")],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={hours === value ? "active" : ""}
              aria-pressed={hours === value}
              onClick={() => setHours(Number(value))}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          className="secondary icon-button"
          aria-label={tr("刷新统计")}
          title={tr("刷新统计")}
          onClick={refresh}
        >
          <Icon name="refresh" />
        </button>
        {!management && (
          <a className="button" href="#/auth?create=1">
            <Icon name="plus" size={14} />
            {tr("创建密钥")}
          </a>
        )}
      </PageHeading>
      <Notice
        message={stats.error ? tr("调用统计暂不可用：") + stats.error : ""}
      />
      <div className="stats four">
        <Stat
          title={tr("总请求数")}
          value={number(d?.requests)}
          note={
            d
              ? tr("{0} 成功 · {1} 失败 · {2} 取消", {
                  "0": textValue(d.successes),
                  "1": textValue(d.errors),
                  "2": textValue(d.cancelled),
                })
              : tr("等待调用数据")
          }
          icon="activity"
        />
        <TokenStat
          input={d?.inputTokens}
          output={d?.outputTokens}
          note={
            d
              ? tr("{0}/{1} 次请求返回用量", {
                  "0": textValue(d.usageKnownRequests),
                  "1": textValue(d.requests),
                })
              : ""
          }
        />
        <Stat
          title={tr("平均首 Token 延迟")}
          value={latency(d?.avgFirstTokenMs)}
          note={
            d
              ? tr("成功流式请求 · 平均完成耗时 {0}", {
                  "0": textValue(latency(d.avgLatencyMs)),
                })
              : tr("文本或工具首次输出")
          }
          icon="clock"
        />
        <Stat
          title={tr("余额扣费")}
          value={money(d?.wallet.chargedUSD)}
          note={walletNote(d?.wallet)}
          icon="money"
        />
      </div>
      <ConsumptionBreakdown value={d?.consumption} />
      <div className="dashboard-grid">
        <section className="panel chart-panel">
          <div className="panel-heading">
            <div>
              <h2>{tr("调用趋势")}</h2>
            </div>
            <span className="chart-legend">
              <i />
              {tr("请求")}
              <i className="error" />
              {tr("错误")}
            </span>
          </div>
          <RequestChart series={d?.series ?? []} />
          {d?.requests === 0 && (
            <p className="chart-empty">{tr("暂无调用记录")}</p>
          )}
        </section>
        <section className="panel">
          <div className="panel-heading">
            <h2>{tr("热门模型")}</h2>
            {!management && (
              <a className="text-link" href="#/models">
                {tr("全部模型")}
                <Icon name="arrow" size={14} />
              </a>
            )}
          </div>
          {d?.models.length ? (
            <div className="model-rank">
              {d.models.map((m, i) => (
                <div key={m.model}>
                  <span className="rank-num">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <strong>{m.model || tr("解析失败")}</strong>
                    <small>{number(m.tokens)} Token</small>
                  </div>
                  <span>
                    {number(m.requests)} {tr("次")}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="quiet-empty">
              <Icon name="models" size={30} />
              <p>{tr("暂无模型用量")}</p>
            </div>
          )}
        </section>
      </div>
      <section className="recent-requests" aria-label={tr("最近调用")}>
        <div className="panel-heading">
          <h2>{tr("最近调用")}</h2>
          <a className="text-link" href="#/activity">
            {tr("查看全部")}
            <Icon name="arrow" size={14} />
          </a>
        </div>
        <Notice
          message={recent.error ? tr("最近调用暂不可用：") + recent.error : ""}
        />
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">{tr("用户 / API Key")}</th>
                <th scope="col">{tr("模型")}</th>
                <th scope="col">{tr("状态")}</th>
                <th scope="col" className="numeric">
                  {tr("耗时")}
                </th>
                <th scope="col" className="numeric">
                  {tr("输入 Token")}
                </th>
                <th scope="col" className="numeric">
                  {tr("输出 Token")}
                </th>
                <th scope="col" className="numeric">
                  {tr("调用时间")}
                </th>
              </tr>
            </thead>
            <tbody>
              {recent.data?.data.map((request) => (
                <tr key={request.id}>
                  <td>
                    <strong>{request.user_name || tr("未知用户")}</strong>
                    <small>
                      {request.key_name ||
                        (request.key_id ? tr("名称不可用") : tr("控制台会话"))}
                    </small>
                  </td>
                  <td>
                    <strong>{request.model || "—"}</strong>
                    <small>
                      {tr("思考强度")}: {request.effort || "—"}
                    </small>
                  </td>
                  <td>
                    <span
                      className={
                        "badge " +
                        (request.status === "success"
                          ? "ready"
                          : request.status === "error"
                            ? "error"
                            : "")
                      }
                    >
                      {outcome[request.status] ?? request.status}
                    </span>
                  </td>
                  <td className="numeric">{latency(request.latency_ms)}</td>
                  <td className="numeric">{number(request.input_tokens)}</td>
                  <td className="numeric">{number(request.output_tokens)}</td>
                  <td className="numeric muted">
                    <time dateTime={new Date(request.created_at).toISOString()}>
                      {new Date(request.created_at).toLocaleString(
                        getLocale(),
                        {
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: false,
                        },
                      )}
                    </time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!recent.data && !recent.error && (
            <p className="empty-inline" role="status">
              {tr("正在加载调用记录…")}
            </p>
          )}
          {recent.data?.total === 0 && (
            <p className="empty-inline">{tr("还没有调用记录。")}</p>
          )}
        </div>
      </section>
      {!management && (
        <section className="endpoint-strip" aria-label={tr("API 接入")}>
          <Icon name="channels" size={18} />
          <div className="endpoint-strip-label">
            <strong>{tr("API 接入")}</strong>
            <small>
              {tr("{0} 个已启用模型", {
                "0": textValue(models.data?.length ?? "—"),
              })}
            </small>
          </div>
          <div className="endpoint-address">
            <code>{endpoint}</code>
            <button
              className="ghost icon-button"
              aria-label={tr("复制 Base URL")}
              onClick={() => {
                void navigator.clipboard.writeText(endpoint).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
            >
              <Icon name={copied ? "check" : "copy"} size={14} />
            </button>
            <span className="sr-only" role="status">
              {copied ? tr("Base URL 已复制") : ""}
            </span>
          </div>
          <div className="actions">
            <a className="text-link" href="#/auth">
              {tr("管理密钥")}
            </a>
          </div>
        </section>
      )}
    </>
  );
}
