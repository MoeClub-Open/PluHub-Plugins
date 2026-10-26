import { t as tr } from "./i18n.js";
import { money, number, Stat, type Summary } from "./components.js";

export function TokenStat({
  input,
  output,
  note = "",
}: {
  input?: number;
  output?: number;
  note?: string;
}) {
  return (
    <Stat
      title={tr("Token 用量")}
      icon="models"
      note={note}
      value={
        <span className="stat-token-values">
          <span>
            <small>{tr("输入")}</small>
            {number(input)}
          </span>
          <span>
            <small>{tr("输出")}</small>
            {number(output)}
          </span>
        </span>
      }
    />
  );
}

export const consumptionSources: Record<string, string> = {
  platform: "平台渠道",
  byoapi: "BYOAPI",
  byosub: "BYOSUB",
  personal: "个人渠道",
  unknown: "未分类",
  unrouted: "未进入渠道",
};
export const consumptionLabel = (source?: string) =>
  tr(consumptionSources[source ?? "unknown"] ?? "未分类");

export function walletNote(wallet?: Summary["wallet"]) {
  if (!wallet) return "";
  return [
    wallet.pendingRequests
      ? tr("{0} 笔待结算", { "0": String(wallet.pendingRequests) })
      : "",
    wallet.unknownRequests
      ? tr("{0} 笔结算未知", { "0": String(wallet.unknownRequests) })
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function ConsumptionBreakdown({
  value,
}: {
  value?: Summary["consumption"];
}) {
  if (!value) return null;
  const sources = Object.keys(consumptionSources).filter(
    (source) =>
      ["platform", "byoapi", "byosub"].includes(source) ||
      value.some((row) => row.source === source),
  );
  return (
    <div className="table-wrap">
      <table aria-label={tr("消耗分类")}>
        <thead>
          <tr>
            <th>{tr("消耗来源")}</th>
            <th className="numeric">{tr("请求数")}</th>
            <th className="numeric">{tr("输入 Token")}</th>
            <th className="numeric">{tr("输出 Token")}</th>
            <th className="numeric">{tr("估算消耗 (USD)")}</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((source) => {
            const row = value.find((item) => item.source === source);
            return (
              <tr key={source}>
                <td>{consumptionLabel(source)}</td>
                <td className="numeric">{number(row?.requests ?? 0)}</td>
                <td className="numeric">
                  {row && !row.usageKnownRequests
                    ? "—"
                    : number(row?.inputTokens ?? 0)}
                </td>
                <td className="numeric">
                  {row && !row.usageKnownRequests
                    ? "—"
                    : number(row?.outputTokens ?? 0)}
                </td>
                <td className="numeric">
                  {money(row ? row.estimatedCostUSD : 0)}
                  {row && row.pricedRequests < row.requests && (
                    <small>
                      {tr("已计价 {0}/{1} 笔", {
                        "0": String(row.pricedRequests),
                        "1": String(row.requests),
                      })}
                    </small>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
