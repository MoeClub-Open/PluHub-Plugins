import type { ModelDefinition, ModelRoute } from "@pluhub/contracts/ai";
import { t as tr, textValue } from "../../lib/ui/i18n.js";
import { ModelEndpoints } from "../../lib/ui/model-endpoints.js";

export type Model = {
  definition?: ModelDefinition;
  alias: string;
  model: string;
  inputPrice: string;
  outputPrice: string;
  upstreamInputPrice: string;
  upstreamOutputPrice: string;
  pricingSource?: string;
  operations?: ModelRoute["operations"];
};
export const emptyModel = (): Model => ({
  alias: "",
  model: "",
  inputPrice: "",
  outputPrice: "",
  upstreamInputPrice: "",
  upstreamOutputPrice: "",
});
const prices = {
  inputPrice: "输入原价",
  outputPrice: "输出原价",
  upstreamInputPrice: "上游输入报价",
  upstreamOutputPrice: "上游输出报价",
} as const;

export function PersonalModels({
  models,
  change,
  subscription,
  busy,
  references,
}: {
  models: Model[];
  change: (models: Model[]) => void;
  subscription: boolean;
  busy: boolean;
  references: any[];
}) {
  const patch = (index: number, value: Partial<Model>) =>
    change(
      models.map((model, i) => (i === index ? { ...model, ...value } : model)),
    );
  return (
    <>
      <div className="personal-models is-sub">
        <table>
          <thead>
            <tr>
              <th>{tr("公开模型名")}</th>
              <th>{tr("上游模型名")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {models.map((model, index) => (
              <tr key={index}>
                <td>
                  <input
                    aria-label={tr("公开模型名 {0}", {
                      "0": textValue(index + 1),
                    })}
                    value={model.alias}
                    required
                    maxLength={256}
                    disabled={busy}
                    onChange={(event) =>
                      patch(index, {
                        alias: event.target.value,
                        model:
                          model.model === model.alias
                            ? event.target.value
                            : model.model,
                      })
                    }
                  />
                </td>
                <td>
                  <input
                    aria-label={tr("上游模型名 {0}", {
                      "0": textValue(index + 1),
                    })}
                    list={
                      subscription ? "subscription-model-catalog" : undefined
                    }
                    value={model.model}
                    required
                    maxLength={256}
                    disabled={busy}
                    onChange={(event) =>
                      patch(index, {
                        model: event.target.value,
                        alias:
                          !model.alias || model.alias === model.model
                            ? event.target.value
                            : model.alias,
                      })
                    }
                  />
                  {!subscription && (
                    <details>
                      <summary>{tr("可用端点")}</summary>
                      <ModelEndpoints
                        value={model.operations}
                        onChange={(operations) => patch(index, { operations })}
                      />
                    </details>
                  )}
                </td>
                <td>
                  <button
                    type="button"
                    className="ghost danger"
                    aria-label={tr("删除模型 {0}", {
                      "0": textValue(index + 1),
                    })}
                    disabled={busy || models.length === 1}
                    onClick={() => change(models.filter((_, i) => i !== index))}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!subscription && (
        <details>
          <summary>{tr("价格设置（USD / 百万 Token，可选）")}</summary>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() =>
              change(
                models.map((model) => {
                  const ref = references.find(
                    (item) =>
                      item.id === model.alias || item.id === model.model,
                  );
                  return ref
                    ? {
                        ...model,
                        inputPrice:
                          model.inputPrice ||
                          (ref.inputPrice === undefined
                            ? ""
                            : String(ref.inputPrice)),
                        outputPrice:
                          model.outputPrice ||
                          (ref.outputPrice === undefined
                            ? ""
                            : String(ref.outputPrice)),
                      }
                    : model;
                }),
              )
            }
          >
            {tr("匹配平台原价")}
          </button>
          <div className="personal-models">
            <table>
              <thead>
                <tr>
                  <th>{tr("模型")}</th>
                  {Object.values(prices).map((label) => (
                    <th key={label}>{tr(label)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {models.map((model, index) => (
                  <tr key={index}>
                    <td>{model.alias || model.model || "—"}</td>
                    {(Object.keys(prices) as (keyof typeof prices)[]).map(
                      (field) => (
                        <td key={field}>
                          <input
                            type="number"
                            min="0"
                            max="1000000"
                            step="any"
                            aria-label={tr(prices[field]) + " " + (index + 1)}
                            placeholder={tr("未知")}
                            value={model[field]}
                            disabled={busy}
                            onInvalid={(event) => {
                              event.currentTarget.closest("details")!.open =
                                true;
                            }}
                            onChange={(event) =>
                              patch(index, {
                                [field]: event.target.value,
                                pricingSource: "manual",
                              })
                            }
                          />
                        </td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </>
  );
}
