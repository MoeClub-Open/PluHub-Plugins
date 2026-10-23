import React from "react";
import type { ModelRoute, ModelPricing } from "@pluhub/contracts/ai";
import { Select } from "./select.js";
import { t as tr } from "./i18n.js";
import { ExpressionPriceFields } from "./expression-price-fields.js";

const cacheFields = ["cacheRead", "cacheWrite", "cacheWrite1h"] as const;
const labels = () => ({
  cacheRead: tr("缓存读取"),
  cacheWrite: tr("缓存写入 · 5 分钟"),
  cacheWrite1h: tr("缓存写入 · 1 小时"),
});
export function readModelPricing(f: FormData): ModelPricing | undefined {
  const search = String(f.get("webSearchPrice") ?? "").trim();
  const extra = search ? { webSearch: Number(search) } : {};
  const mode = String(f.get("billingMode") ?? "tokens") as NonNullable<
    ModelPricing["mode"]
  >;
  if (mode === "expression")
    return {
      mode,
      expression: String(f.get("billingExpression") ?? "").trim(),
      ...extra,
    };
  if (mode === "request")
    return { mode, request: Number(f.get("requestPrice")), ...extra };
  const pricing: ModelPricing = { ...extra };
  for (const key of cacheFields) {
    const value = String(f.get(key) ?? "").trim();
    if (value) pricing[key] = Number(value);
  }
  const thresholds = f.getAll("tierAbove");
  if (thresholds.length)
    pricing.tiers = thresholds
      .map((value, i) => {
        const tier: NonNullable<ModelPricing["tiers"]>[number] = {
          above: Number(value),
          input: Number(f.getAll("tierInput")[i]),
          output: Number(f.getAll("tierOutput")[i]),
        };
        for (const key of cacheFields) {
          const v = String(f.getAll("tier." + key)[i] ?? "").trim();
          if (v) tier[key] = Number(v);
        }
        return tier;
      })
      .sort((a, b) => a.above - b.above);
  return Object.keys(pricing).length ? pricing : undefined;
}
export function ModelPriceFields({ model }: { model?: ModelRoute }) {
  const [mode, setMode] = React.useState(model?.pricing?.mode ?? "tokens");
  const [tiers, setTiers] = React.useState(() =>
    (model?.pricing?.tiers ?? []).map((tier) => ({
      ...tier,
      key: crypto.randomUUID(),
    })),
  );
  const rate = (
    name: string,
    title: string,
    value?: number,
    required = false,
  ) => (
    <label key={name}>
      {title}
      <input
        name={name}
        type="number"
        min="0"
        max="1000000"
        step="any"
        defaultValue={value ?? ""}
        required={required}
        placeholder={tr("可选，空表示未知")}
      />
    </label>
  );
  return (
    <>
      {rate(
        "webSearchPrice",
        tr("网页搜索原价 · USD / 次"),
        model?.pricing?.webSearch,
      )}
      <label>
        {tr("计价方式")}
        <Select
          name="billingMode"
          value={mode}
          onChange={(e) => setMode(e.target.value as typeof mode)}
        >
          <option value="tokens">{tr("按 Token 计费")}</option>
          <option value="request">{tr("按次计费")}</option>
          <option value="expression">{tr("表达式计价")}</option>
        </Select>
      </label>
      {mode === "expression" ? (
        <>
          {rate("inputPrice", tr("输入原价 / 百万 Token"), model?.inputPrice)}
          {rate("outputPrice", tr("输出原价 / 百万 Token"), model?.outputPrice)}
          <ExpressionPriceFields model={model} />
        </>
      ) : mode === "request" ? (
        rate(
          "requestPrice",
          tr("每次原价 · USD"),
          model?.pricing?.request,
          true,
        )
      ) : (
        <>
          {rate("inputPrice", tr("输入原价 / 百万 Token"), model?.inputPrice)}
          {rate("outputPrice", tr("输出原价 / 百万 Token"), model?.outputPrice)}
          <details className="full">
            <summary>{tr("缓存与阶梯价格")}</summary>
            <div className="form-grid">
              {cacheFields.map((key) =>
                rate(key, labels()[key] + " · USD / 1M", model?.pricing?.[key]),
              )}
            </div>
            <p className="field-note">
              {tr("缓存价格留空时使用输入价格；阶梯价格按总输入长度选择。")}
            </p>
            {tiers.map((tier, i) => (
              <fieldset className="card" key={tier.key}>
                <legend>{tr("阶梯 {0}", { "0": String(i + 1) })}</legend>
                <div className="form-grid">
                  <label>
                    {tr("输入 Token 超过")}
                    <input
                      name="tierAbove"
                      type="number"
                      min="0"
                      step="1"
                      defaultValue={tier.above}
                      required
                    />
                  </label>
                  {rate(
                    "tierInput",
                    tr("输入原价 / 百万 Token"),
                    tier.input,
                    true,
                  )}
                  {rate(
                    "tierOutput",
                    tr("输出原价 / 百万 Token"),
                    tier.output,
                    true,
                  )}
                  {cacheFields.map((key) =>
                    rate(
                      "tier." + key,
                      labels()[key] + " · USD / 1M",
                      tier[key],
                    ),
                  )}
                </div>
                <button
                  type="button"
                  className="ghost danger"
                  onClick={() =>
                    setTiers((rows) => rows.filter((t) => t.key !== tier.key))
                  }
                >
                  {tr("删除阶梯")}
                </button>
              </fieldset>
            ))}
            <button
              type="button"
              className="secondary"
              disabled={tiers.length >= 32}
              onClick={() =>
                setTiers((rows) => [
                  ...rows,
                  {
                    key: crypto.randomUUID(),
                    above: rows.length ? rows.at(-1)!.above + 100000 : 200000,
                    input: model?.inputPrice ?? 0,
                    output: model?.outputPrice ?? 0,
                  },
                ])
              }
            >
              {tr("添加阶梯")}
            </button>
          </details>
        </>
      )}
    </>
  );
}
