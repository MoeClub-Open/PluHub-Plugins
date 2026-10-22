import { t as tr } from "./i18n.js";
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
  };
  const p = receipt.pricing;
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
                {receipt.mode === "request"
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
        {tr("渠道倍率")} ×{p.multiplier ?? 1} · {tr("计费分组")}{" "}
        {p.group ?? "default"} ×{p.groupMultiplier ?? 1} · {tr("用户倍率")} ×
        {p.userMultiplier ?? 1}
      </p>
      {receipt.tierAbove !== undefined && (
        <p>
          {tr("输入 Token 超过")} {receipt.tierAbove}
        </p>
      )}
      <strong>${(receipt.amount / 1e6).toFixed(6)}</strong>
    </details>
  );
}
