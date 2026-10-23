import { t as tr } from "../../lib/ui/i18n.js";
import { number } from "../../lib/ui/components.js";
export function RoutingDetails({ value }: { value: string }) {
  let data: Record<string, any>;
  try {
    data = JSON.parse(value);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const { outputBudget: budget, webSearchCalls, ...routing } = data;
  const bounded =
    budget?.mode === "bounded" && Number.isSafeInteger(budget.limit);
  const estimated =
    budget?.mode === "estimate" &&
    Number.isSafeInteger(budget.reservedTokens) &&
    budget.reservedTokens > 0;
  return (
    <>
      {Number.isSafeInteger(webSearchCalls) && (
        <dl className="detail-grid">
          <div>
            <dt>{tr("网页搜索")}</dt>
            <dd>{number(webSearchCalls)}</dd>
          </div>
        </dl>
      )}
      {(bounded || estimated) && (
        <dl className="detail-grid">
          <div>
            <dt>{tr("输出预算")}</dt>
            <dd>{bounded ? tr("已应用上限") : tr("仅估算预留")}</dd>
          </div>
          <div>
            <dt>
              {bounded ? tr("输出上限（Token）") : tr("预留参考（Token）")}
            </dt>
            <dd>{number(bounded ? budget.limit : budget.reservedTokens)}</dd>
          </div>
          <div>
            <dt>{tr("上限来源")}</dt>
            <dd>
              {budget.source === "default"
                ? tr("站点默认")
                : tr("请求或渠道配置")}
            </dd>
          </div>
        </dl>
      )}
      {Object.keys(routing).length > 0 && (
        <div className="card">
          <h3>{tr("自动路由 / 思考设置")}</h3>
          <pre>{JSON.stringify(routing, null, 2)}</pre>
        </div>
      )}
    </>
  );
}
