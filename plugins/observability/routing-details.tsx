import { t as tr } from "../../lib/ui/i18n.js";
import { number } from "../../lib/ui/components.js";
export function RoutingDetails({
  value,
  requestedModel,
  responseModel,
}: {
  value?: string | null;
  requestedModel?: string;
  responseModel?: string | null;
}) {
  let data: Record<string, any> = {};
  try {
    if (value) data = JSON.parse(value);
  } catch {
    // The response model can still be displayed if routing data is invalid.
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
  const { outputBudget: budget, webSearchCalls, targetModel, ...routing } = data;
  const bounded =
    budget?.mode === "bounded" && Number.isSafeInteger(budget.limit);
  const estimated =
    budget?.mode === "estimate" &&
    Number.isSafeInteger(budget.reservedTokens) &&
    budget.reservedTokens > 0;
  return (
    <>
      {routing.attempts?.length > 0 && (
        <dl className="detail-grid">
          <div>
            <dt>{tr("备用切换")}</dt>
            <dd>
              {routing.attempts
                .map((attempt: any) => attempt.model + " · " + attempt.error)
                .join(" → ")}
            </dd>
          </div>
        </dl>
      )}
      {((typeof targetModel === "string" && targetModel !== requestedModel) ||
        responseModel) && (
          <dl className="detail-grid">
            {typeof targetModel === "string" &&
              targetModel !== requestedModel && (
                <div>
                  <dt>{tr("上游请求模型")}</dt>
                  <dd>{targetModel}</dd>
                </div>
              )}
            {responseModel && (
              <div>
                <dt>{tr("上游返回模型")}</dt>
                <dd>{responseModel}</dd>
              </div>
            )}
          </dl>
        )}
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
        <details>
          <summary>{tr("路由诊断")}</summary>
          <pre>{JSON.stringify(routing, null, 2)}</pre>
        </details>
      )}
    </>
  );
}
