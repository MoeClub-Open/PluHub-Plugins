import React from "react";
import type { ModelRoute } from "@pluhub/contracts/ai";
import { Checkbox } from "./checkbox.js";
import { t as tr } from "./i18n.js";

export const modelEndpoints = [
  ["chat", "对话"],
  ["embeddings", "向量"],
  ["images/generations", "图片生成"],
  ["images/edits", "图片编辑"],
  ["audio/speech", "语音合成"],
  ["audio/transcriptions", "语音转写"],
  ["audio/translations", "音频翻译"],
] as const;
export function ModelEndpoints({
  value,
  onChange,
}: {
  value?: ModelRoute["operations"];
  onChange?: (value: NonNullable<ModelRoute["operations"]>) => void;
}) {
  const [selected, setSelected] = React.useState<
    NonNullable<ModelRoute["operations"]>
  >(value ?? ["chat"]);
  const values: NonNullable<ModelRoute["operations"]> = onChange
    ? (value ?? ["chat"])
    : selected;
  return (
    <fieldset className="full">
      <legend>{tr("可用端点")}</legend>
      <div className="actions">
        {modelEndpoints.map(([key, label]) => (
          <label className="check" key={key}>
            <Checkbox
              name="operations"
              value={key}
              checked={values.includes(key)}
              onCheckedChange={(checked) => {
                const next = checked
                  ? [...values, key]
                  : values.filter((v) => v !== key);
                if (onChange) onChange(next);
                else setSelected(next);
              }}
            />
            {tr(label)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
