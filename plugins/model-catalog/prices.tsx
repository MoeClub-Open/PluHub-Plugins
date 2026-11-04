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
  return kind === "request"
    ? model.pricing?.request
    : kind === "input"
      ? model.inputPrice
      : model.outputPrice;
};

export function ModelPrices({ model }: { model: CatalogModel }) {
  if (model.pricing?.mode === "expression")
    return (
      <ExpressionPrices
        source={model.pricing.expression!}
        formatPrice={formatPrice}
      />
    );
  const original = {
    input: model.inputPrice,
    output: model.outputPrice,
    ...model.pricing,
  };
  const fields: [keyof TokenPrices, string][] = [
    ["input", tr("输入")],
    ["output", tr("输出")],
    ["cacheRead", tr("缓存读取")],
    ["cacheWrite", tr("缓存写入 · 5 分钟")],
    ["cacheWrite1h", tr("缓存写入 · 1 小时")],
  ];
  const rows = (rates: Partial<TokenPrices>) =>
    fields
      .filter(([key]) => rates[key] !== undefined)
      .map(([key, label]) => (
        <tr key={key}>
          <td>{label} / 1M</td>
          <td>{formatPrice(rates[key])}</td>
        </tr>
      ));
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{tr("计价项目")}</th>
            <th>{tr("价格 · USD")}</th>
          </tr>
        </thead>
        <tbody>
          {original.mode === "request" ? (
            <tr>
              <td>{tr("每次请求")}</td>
              <td>{formatPrice(original.request)}</td>
            </tr>
          ) : (
            <>
              {rows(original)}
              {original.tiers?.map((tier) => (
                <React.Fragment key={tier.above}>
                  <tr>
                    <th colSpan={2}>
                      {tr("输入 Token 超过")} {number(tier.above)}
                    </th>
                  </tr>
                  {rows({ ...original, ...tier })}
                </React.Fragment>
              ))}
            </>
          )}
        </tbody>
      </table>
    </div>
  );
}
