import { t as tr, getLocale } from "./i18n.js";
import type { PriceReceipt } from "../commerce/pricing.js";
export function PriceReceiptView({
  value,
  title,
}: {
  value?: string | null;
  title?: string;
}) {
  let receipt: PriceReceipt;
  try {
    receipt = JSON.parse(value ?? "null");
    if (!receipt?.lines) return null;
  } catch {
    return null;
  }
  const labels: Record<string, string> = {
    input: tr("输入"),
    output: tr("输出"),
    cacheRead: tr("缓存读取"),
    cacheWrite: tr("缓存写入 · 5 分钟"),
    cacheWrite1h: tr("缓存写入 · 1 小时"),
    request: tr("请求"),
    expression: tr("表达式计价"),
  };
  const p = receipt.pricing;
  const multiplier = p.multiplier ?? 1;
  return (
    <details>
      <summary>{title ?? tr("计费明细")}</summary>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{tr("项目")}</th>
              <th>{tr("数量")}</th>
              <th>
                {receipt.expression
                  ? "USD"
                  : receipt.mode === "request"
                    ? tr("USD / 次")
                    : tr("USD / 百万 Token")}
              </th>
            </tr>
          </thead>
          <tbody>
            {receipt.lines.map((line) => (
              <tr key={line.kind}>
                <td>{labels[line.kind] ?? line.kind}</td>
                <td>{line.quantity}</td>
                <td>{line.rate}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        {tr("消耗倍率")} ×{Number(multiplier.toPrecision(12))}
      </p>
      {receipt.tierAbove !== undefined && (
        <p>
          {tr("输入 Token 超过")} {receipt.tierAbove}
        </p>
      )}
      {receipt.tier && (
        <p>
          {tr("计价档位")} · {receipt.tier}
        </p>
      )}
      {receipt.pricing.context && (
        <p>
          {tr("计价时间")} ·{" "}
          {new Date(receipt.pricing.context.at).toLocaleString(getLocale())}
        </p>
      )}
      {receipt.expression && (
        <details>
          <summary>{tr("定价规则")}</summary>
          <pre>{receipt.expression}</pre>
          <div className="detail-grid">
            {Object.entries(receipt.variables ?? {}).map(([name, value]) => (
              <span key={name}>
                {name} · {value}
              </span>
            ))}
          </div>
        </details>
      )}
      <strong>${(receipt.amount / 1e6).toFixed(6)}</strong>
    </details>
  );
}
