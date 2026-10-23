import React from "react";
import type { CatalogModel, TokenPrices } from "@pluhub/contracts/ai";
import { t as tr, getLocale } from "../../lib/ui/i18n.js";
import { number } from "../../lib/ui/components.js";
import { ExpressionPrices } from "./expression-prices.js";

export const formatPrice = (value?: number) =>
  value === undefined
    ? tr("暂未公布")
    : value === 0
      ? tr("免费")
      : "$" +
        new Intl.NumberFormat(getLocale(), {
          maximumSignificantDigits: 8,
        }).format(value);
export const consumptionPrice = (
  model: CatalogModel,
  kind: "input" | "output" | "request",
) => {
  if (model.pricing?.mode === "expression") return undefined;
  const base =
    model.billing?.[kind] ??
    (kind === "request"
      ? model.pricing?.request
      : kind === "input"
        ? model.inputPrice
        : model.outputPrice);
  return base === undefined
    ? undefined
    : base * (model.billing?.multiplier ?? model.consumptionMultiplier ?? 1);
};

export function ModelPrices({ model }: { model: CatalogModel }) {
  const factor = model.billing?.multiplier ?? model.consumptionMultiplier ?? 1;
  if (model.pricing?.mode === "expression")
    return (
      <ExpressionPrices
        source={model.pricing.expression!}
        multiplier={factor}
        formatPrice={formatPrice}
      />
    );
  const original = {
    input: model.inputPrice,
    output: model.outputPrice,
    ...model.pricing,
  };
  const billing = model.billing ?? original;
  const fields: [keyof TokenPrices, string][] = [
    ["input", tr("输入")],
    ["output", tr("输出")],
    ["cacheRead", tr("缓存读取")],
    ["cacheWrite", tr("缓存写入 · 5 分钟")],
    ["cacheWrite1h", tr("缓存写入 · 1 小时")],
  ];
  const rows = (rates: Partial<TokenPrices>, applied: Partial<TokenPrices>) =>
    fields
      .filter(([key]) => rates[key] !== undefined || applied[key] !== undefined)
      .map(([key, label]) => (
        <tr key={key}>
          <td>{label} / 1M</td>
          <td>{formatPrice(rates[key])}</td>
          <td>
            {formatPrice(
              applied[key] === undefined ? undefined : applied[key]! * factor,
            )}
          </td>
        </tr>
      ));
  return (
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
          {original.mode === "request" ? (
            <tr>
              <td>{tr("每次请求")}</td>
              <td>{formatPrice(original.request)}</td>
              <td>{formatPrice(consumptionPrice(model, "request"))}</td>
            </tr>
          ) : (
            <>
              {rows(original, billing)}
              {original.tiers?.map((tier) => (
                <React.Fragment key={tier.above}>
                  <tr>
                    <th colSpan={3}>
                      {tr("输入 Token 超过")} {number(tier.above)}
                    </th>
                  </tr>
                  {rows(
                    { ...original, ...tier },
                    {
                      ...billing,
                      ...(billing.tiers?.find(
                        (item) => item.above === tier.above,
                      ) ?? tier),
                    },
                  )}
                </React.Fragment>
              ))}
            </>
          )}
        </tbody>
      </table>
    </div>
  );
}
