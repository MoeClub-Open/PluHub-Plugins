import { t as tr, textValue } from "../../lib/ui/i18n.js";
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
  function refresh() {
    stats.reload();
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
        />
        <Stat
          title={tr("耗时")}
          value={
            <span className="stat-pair-values" title={tr("平均耗时")}>
              <span>
                <small>{tr("首字")}</small>
                {latency(d?.avgFirstTokenMs)}
              </span>
              <span>
                <small>{tr("总用时")}</small>
                {latency(d?.avgLatencyMs)}
              </span>
            </span>
          }
          icon="clock"
        />
        <Stat
          title={tr("消耗金额")}
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
