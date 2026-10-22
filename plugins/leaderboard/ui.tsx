import { t as tr, textValue, getLocale } from "../../lib/ui/i18n.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import type {
  Leaderboard,
  LeaderboardRow,
  RankingKind,
  RankingMetric,
  RankingRange,
} from "@pluhub/contracts/analytics";
import { mountPage, Notice } from "../../lib/ui/mount.js";
import { Select } from "../../lib/ui/select.js";
import { Empty, Icon, PageHeading, number } from "../../lib/ui/components.js";
import { styles } from "./ui-style.js";

const exactNumber = (value: number) => value.toLocaleString(getLocale());
const date = (value: number) =>
  new Date(value).toLocaleDateString(getLocale(), { timeZone: "UTC" });

function Page({ host }: { host: UIHost }) {
  const [kind, setKind] = React.useState<RankingKind>("users");
  const [range, setRange] = React.useState<RankingRange>("7d");
  const [metric, setMetric] = React.useState<RankingMetric>("tokens");
  const [version, setVersion] = React.useState(0);
  const [data, setData] = React.useState<Leaderboard>();
  const [busy, setBusy] = React.useState(true);
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError("");
    const query = new URLSearchParams({ kind, range, metric });
    void host
      .request<Leaderboard>(
        "/api/plugins/official.leaderboard/rankings?" + query,
        { signal: controller.signal },
      )
      .then((value) => {
        if (!controller.signal.aborted) setData(value);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(failure.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [host, kind, range, metric, version]);
  const current =
    data?.kind === kind && data.range === range && data.metric === metric
      ? data
      : undefined;
  const cell = (row: LeaderboardRow, pinned = false) => (
    <tr
      key={pinned ? "my-rank" : row.rank + ":" + (row.modelId ?? row.name)}
      className={row.isCurrentUser ? "leaderboard-me" : undefined}
    >
      <td>
        <span
          className={"leaderboard-rank rank-" + Math.min(row.rank, 4)}
          aria-label={tr("第 ") + row.rank + tr(" 名")}
        >
          {row.rank <= 3 ? <Icon name="trophy" size={15} /> : null}
          {row.rank}
        </span>
      </td>
      <td>
        <div className="leaderboard-identity">
          <span className="leaderboard-avatar" aria-hidden="true">
            {kind === "models" ? (
              <Icon name="models" size={17} />
            ) : (
              row.name.slice(0, 1).toUpperCase()
            )}
          </span>
          <div>
            <strong title={row.name}>{row.name}</strong>
            {kind === "models" && (
              <small title={row.modelId}>
                {row.provider} · {row.modelId}
              </small>
            )}
          </div>
          {row.isCurrentUser && <span className="badge">{tr("我")}</span>}
        </div>
      </td>
      <td className={metric === "tokens" ? "leaderboard-sorted" : undefined}>
        <strong title={exactNumber(row.tokens)}>{number(row.tokens)}</strong>
        <small
          title={
            tr("输入 ") +
            exactNumber(row.inputTokens) +
            tr(" / 输出 ") +
            exactNumber(row.outputTokens)
          }
        >
          {number(row.inputTokens)} / {number(row.outputTokens)}
        </small>
      </td>
      <td className={metric === "requests" ? "leaderboard-sorted" : undefined}>
        <strong title={exactNumber(row.requests)}>
          {number(row.requests)}
        </strong>
      </td>
      <td>
        <div className="leaderboard-share">
          <span>{(row.share * 100).toFixed(1)}%</span>
          <div className="leaderboard-meter" aria-hidden="true">
            <i style={{ width: row.share * 100 + "%" }} />
          </div>
        </div>
      </td>
    </tr>
  );
  return (
    <div className="leaderboard">
      <style>{styles}</style>
      <PageHeading title={tr("排行榜")}>
        <Select
          aria-label={tr("排行榜时间范围")}
          value={range}
          onChange={(event) => setRange(event.target.value as RankingRange)}
        >
          <option value="7d">{tr("近 7 天")}</option>
          <option value="30d">{tr("近 30 天")}</option>
          <option value="all">{tr("累计")}</option>
        </Select>
        <Select
          aria-label={tr("排行榜排序")}
          value={metric}
          onChange={(event) => setMetric(event.target.value as RankingMetric)}
        >
          <option value="tokens">{tr("按 Token 用量")}</option>
          <option value="requests">{tr("按调用次数")}</option>
        </Select>
        <button
          className="secondary icon-button"
          aria-label={tr("刷新排行榜")}
          title={tr("刷新排行榜")}
          disabled={busy}
          onClick={() => setVersion((value) => value + 1)}
        >
          <Icon name="refresh" size={16} />
        </button>
      </PageHeading>
      <div
        className="leaderboard-tabs"
        role="tablist"
        aria-label={tr("排行榜分类")}
      >
        {(["users", "models"] as const).map((tab) => (
          <button
            key={tab}
            role="tab"
            id={"leaderboard-tab-" + tab}
            aria-controls="leaderboard-panel"
            aria-selected={kind === tab}
            tabIndex={kind === tab ? 0 : -1}
            className={kind === tab ? "active" : ""}
            onClick={() => setKind(tab)}
            onKeyDown={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              )
                return;
              event.preventDefault();
              const next =
                event.key === "Home"
                  ? "users"
                  : event.key === "End"
                    ? "models"
                    : kind === "users"
                      ? "models"
                      : "users";
              setKind(next);
              event.currentTarget.parentElement
                ?.querySelector<HTMLButtonElement>("#leaderboard-tab-" + next)
                ?.focus();
            }}
          >
            <Icon name={tab === "users" ? "users" : "models"} size={16} />
            {tab === "users" ? tr("用户榜") : tr("模型榜")}
          </button>
        ))}
      </div>
      <Notice message={error} />
      <section
        id="leaderboard-panel"
        role="tabpanel"
        aria-labelledby={"leaderboard-tab-" + kind}
        aria-busy={busy}
      >
        <div className="leaderboard-summary">
          <div>
            <span>{tr("Token 用量")}</span>
            <strong title={current && exactNumber(current.totals.tokens)}>
              {current ? number(current.totals.tokens) : "—"}
            </strong>
          </div>
          <div>
            <span>{tr("成功调用")}</span>
            <strong>{current ? number(current.totals.requests) : "—"}</strong>
          </div>
          <div>
            <span>{kind === "users" ? tr("参与用户") : tr("活跃模型")}</span>
            <strong>
              {current ? number(current.totals.participants) : "—"}
            </strong>
          </div>
          {kind === "users" && (
            <div className="leaderboard-my-summary">
              <span>{tr("我的排名")}</span>
              <strong>{current?.me ? "#" + current.me.rank : "—"}</strong>
            </div>
          )}
        </div>
        {current?.rows.length ? (
          <div className="table-wrap">
            <table
              aria-label={
                kind === "users" ? tr("用户排行榜") : tr("模型排行榜")
              }
            >
              <thead>
                <tr>
                  <th scope="col">{tr("排名")}</th>
                  <th scope="col">
                    {kind === "users" ? tr("用户") : tr("模型")}
                  </th>
                  <th
                    scope="col"
                    aria-sort={metric === "tokens" ? "descending" : "none"}
                  >
                    Token <small>{tr("输入 / 输出")}</small>
                  </th>
                  <th
                    scope="col"
                    aria-sort={metric === "requests" ? "descending" : "none"}
                  >
                    {tr("调用次数")}
                  </th>
                  <th scope="col">{tr("占比")}</th>
                </tr>
              </thead>
              <tbody>{current.rows.map((row) => cell(row))}</tbody>
              {current.me && !current.rows.some((row) => row.isCurrentUser) && (
                <tfoot>{cell(current.me, true)}</tfoot>
              )}
            </table>
          </div>
        ) : (
          <div role="status">
            <Empty
              title={
                busy
                  ? tr("正在加载排行榜…")
                  : error
                    ? tr("排行榜暂不可用")
                    : tr("这个时段还没有排名")
              }
            />
          </div>
        )}
        {current && (
          <div className="leaderboard-footnote">
            <span
              title={tr(
                "按 UTC 自然日汇总；Token 使用上游返回的实际用量。未返回用量的成功请求仅计调用次数。",
              )}
            >
              {date(current.from)} — {date(current.updatedAt)} · UTC
            </span>
            <span>{tr("前 {0} 名", { "0": textValue(current.limit) })}</span>
            {current.totals.usageRequests < current.totals.requests && (
              <span
                title={tr(
                  "部分上游未返回 Token 用量，这些请求不会估算或填入 Token。",
                )}
              >
                {number(current.totals.usageRequests)} {tr("次调用有用量")}
              </span>
            )}
            {range === "all" && (
              <span
                title={tr(
                  "从保留的历史调用回填，之后持续累计；升级前已清理的日志无法恢复。",
                )}
              >
                {tr("统计始于")}
                {date(current.coverageSince)}
              </span>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
export const mount = (element: HTMLElement, host: UIHost) =>
  mountPage(element, host, Page);
