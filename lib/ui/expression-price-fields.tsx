import React from "react";
import type { ModelRoute } from "@pluhub/contracts/ai";
import { Select } from "./select.js";
import { t as tr } from "./i18n.js";

export function ExpressionPriceFields({ model }: { model?: ModelRoute }) {
  const input = model?.inputPrice ?? 2,
    output = model?.outputPrice ?? 8;
  const base = `p * ${input} + c * ${output}`;
  const templates: Record<string, string> = {
    flat: `tier("${tr("标准")}", ${base})`,
    context: `len <= 200000\n  ? tier("${tr("标准")}", ${base})\n  : tier("${tr("长上下文")}", p * ${input * 2} + c * ${output * 1.5})`,
    progressive: `tier("${tr("分段累进")}", min(p, 100000) * ${input} + max(p - 100000, 0) * ${input * 0.8} + c * ${output})`,
    time: `hour("Asia/Shanghai") >= 8 && hour("Asia/Shanghai") < 20\n  ? tier("${tr("高峰")}", ${base})\n  : tier("${tr("低谷")}", p * ${input * 0.8} + c * ${output * 0.8})`,
    request: `tier("${tr("按次计费")}", fixed(0.01))`,
    conditional: `param("service_tier") == "priority"\n  ? tier("${tr("优先")}", p * ${input * 2} + c * ${output * 2})\n  : tier("${tr("标准")}", ${base})`,
  };
  const [expression, setExpression] = React.useState(
    model?.pricing?.expression ?? templates.flat!,
  );
  return (
    <>
      <label className="full">
        {tr("定价模板")}
        <Select
          defaultValue="custom"
          onChange={(event) => {
            if (templates[event.target.value])
              setExpression(templates[event.target.value]!);
          }}
        >
          <option value="custom">{tr("自定义")}</option>
          <option value="flat">{tr("统一单价")}</option>
          <option value="context">{tr("上下文阶梯")}</option>
          <option value="progressive">{tr("分段累进")}</option>
          <option value="time">{tr("分时定价")}</option>
          <option value="request">{tr("按次计费")}</option>
          <option value="conditional">{tr("条件定价")}</option>
        </Select>
      </label>
      <label className="full">
        {tr("计费表达式")}
        <textarea
          name="billingExpression"
          rows={7}
          value={expression}
          onChange={(event) => setExpression(event.target.value)}
          required
          maxLength={16384}
          spellCheck={false}
        />
      </label>
    </>
  );
}
