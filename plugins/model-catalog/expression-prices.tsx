import { expressionRules } from "../../lib/commerce/expression.js";
import { t as tr } from "../../lib/ui/i18n.js";

export function ExpressionPrices({
  source,
  multiplier,
  formatPrice,
}: {
  source: string;
  multiplier: number;
  formatPrice: (value?: number) => string;
}) {
  const names: Record<string, string> = {
    p: tr("输入"),
    c: tr("输出"),
    cr: tr("缓存读取"),
    cc: tr("缓存写入 · 5 分钟"),
    cc1h: tr("缓存写入 · 1 小时"),
    r: tr("思考 Token"),
    total: tr("总 Token"),
  };
  const condition = (value: string) =>
    value
      .replace(/\blen\b/g, tr("输入 Token"))
      .replace(/\btotal\b/g, tr("总 Token"))
      .replace(/\bhour\(/g, tr("小时") + "(")
      .replace(/\bminute\(/g, tr("分钟") + "(")
      .replace(/\bweekday\(/g, tr("星期") + "(")
      .replace(/\bmonth\(/g, tr("月份") + "(")
      .replace(/\byear\(/g, tr("年份") + "(")
      .replace(/\bday\(/g, tr("日期") + "(");
  return (
    <>
      {expressionRules(source).map((rule, index) => (
        <section className="recent-requests" key={index}>
          <div className="section-heading">
            <strong>{rule.name}</strong>
            {rule.condition && (
              <span className="muted">{condition(rule.condition)}</span>
            )}
          </div>
          {rule.request !== undefined || rule.rates ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{tr("计价项目")}</th>
                    <th>{tr("原价 · USD")}</th>
                    <th>{tr("扣费价 · USD")}</th>
                  </tr>
                </thead>
                <tbody>
                  {(rule.mode === "request"
                    ? [["request", rule.request!] as const]
                    : Object.entries(rule.rates!)
                  ).map(([name, rate]) => (
                    <tr key={name}>
                      <td>
                        {name === "request"
                          ? tr("每次请求")
                          : (names[name] ?? name) + " / 1M"}
                      </td>
                      <td>{formatPrice(rate)}</td>
                      <td>{formatPrice(rate * multiplier)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <details>
              <summary>{tr("定价规则")}</summary>
              <pre>{rule.formula}</pre>
            </details>
          )}
        </section>
      ))}
    </>
  );
}
