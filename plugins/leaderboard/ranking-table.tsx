import type {
  Leaderboard,
  LeaderboardRow,
  RankingKind,
  RankingMetric,
} from "@pluhub/contracts/analytics";
import { t as tr, getLocale } from "../../lib/ui/i18n.js";
import { Icon, number } from "../../lib/ui/components.js";
import { ModelLogo } from "../../lib/ui/model-logo.js";
const exactNumber = (value: number) => value.toLocaleString(getLocale());
export function RankingTable({
  rows,
  current,
  kind,
  metric,
  copy,
}: {
  rows: LeaderboardRow[];
  current?: Leaderboard;
  kind: RankingKind;
  metric: RankingMetric;
  copy: (id: string) => Promise<void>;
}) {
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
              <ModelLogo
                model={row.modelId ?? row.name}
                provider={row.provider ?? ""}
              />
            ) : (
              row.name.slice(0, 1).toUpperCase()
            )}
          </span>
          <div>
            <strong title={row.name}>{row.name}</strong>
            {kind === "models" && (
              <small title={row.modelId}>
                {[
                  row.provider,
                  row.modelId !== row.name ? row.modelId : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </small>
            )}
          </div>
          {row.modelId && (
            <button
              className="ghost icon-button leaderboard-copy"
              aria-label={tr("复制模型 ID：") + row.modelId}
              title={tr("复制模型 ID")}
              onClick={() => void copy(row.modelId!)}
            >
              <Icon name="copy" size={13} />
            </button>
          )}
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
    <div className="table-wrap">
      <table
        aria-label={kind === "users" ? tr("用户排行榜") : tr("模型排行榜")}
      >
        <thead>
          <tr>
            <th scope="col">{tr("排名")}</th>
            <th scope="col">{kind === "users" ? tr("用户") : tr("模型")}</th>
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
        <tbody>{rows.map((row) => cell(row))}</tbody>
        {current?.me && !current.rows.some((row) => row.isCurrentUser) && (
          <tfoot>{cell(current.me, true)}</tfoot>
        )}
      </table>
    </div>
  );
}
