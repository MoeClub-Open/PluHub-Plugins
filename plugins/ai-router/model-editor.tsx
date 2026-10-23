import React from "react";
import type { ModelRoute, Upstream } from "@pluhub/contracts/ai";
import { Dialog } from "../../lib/ui/components.js";
import { Checkbox } from "../../lib/ui/checkbox.js";
import { Select } from "../../lib/ui/select.js";
import { ModelEndpoints } from "../../lib/ui/model-endpoints.js";
import {
  ModelPriceFields,
  readModelPricing,
} from "../../lib/ui/model-pricing.js";
import { Notice } from "../../lib/ui/mount.js";
import { t as tr } from "../../lib/ui/i18n.js";

export function ModelEditor({
  id,
  suggestedId,
  model,
  upstreams,
  save,
  close,
}: {
  id?: string;
  suggestedId: string;
  model: ModelRoute;
  upstreams: Record<string, Upstream>;
  save: (id: string, model: ModelRoute) => Promise<void>;
  close: () => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [enabled, setEnabled] = React.useState(model.enabled !== false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? "").trim();
    const next: ModelRoute = {
      ...model,
      upstream: text("upstream"),
      model: text("model"),
      enabled,
      operations: form.getAll("operations") as ModelRoute["operations"],
    };
    for (const field of ["name", "provider", "description"] as const) {
      if (text(field)) next[field] = text(field);
      else delete next[field];
    }
    for (const field of [
      "inputPrice",
      "outputPrice",
      "contextWindow",
    ] as const) {
      if (text(field)) next[field] = Number(text(field));
      else delete next[field];
    }
    next.pricing = readModelPricing(form);
    if (!next.pricing) delete next.pricing;
    if (text("reasoningEfforts"))
      next.reasoningEfforts = text("reasoningEfforts")
        .split(",")
        .map((value) => value.trim()) as ModelRoute["reasoningEfforts"];
    else delete next.reasoningEfforts;
    setBusy(true);
    setMessage("");
    try {
      await save(id || text("id"), next);
      close();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={id ? tr("模型与定价") : tr("添加模型")}
      close={() => {
        if (!busy) close();
      }}
    >
      <form onSubmit={submit}>
        <Notice message={message} />
        {model.model && (
          <p>
            <strong>{model.name || model.model}</strong>
            <small>{upstreams[model.upstream]?.name || model.upstream}</small>
          </p>
        )}
        <div className="form-grid">
          <label className="full">
            {tr("显示名称")}
            <input
              name="name"
              defaultValue={model.name ?? ""}
              maxLength={128}
            />
          </label>
          <ModelPriceFields model={model} />
          <details className="full" open={!model.model}>
            <summary>{tr("模型映射")}</summary>
            <div className="form-grid">
              <label>
                {tr("渠道")}
                <Select name="upstream" required defaultValue={model.upstream}>
                  {Object.entries(upstreams).map(([key, upstream]) => (
                    <option key={key} value={key}>
                      {upstream.name || key}
                    </option>
                  ))}
                </Select>
              </label>
              <label>
                {tr("实际模型 ID")}
                <input name="model" required defaultValue={model.model} />
              </label>
              <label className="full">
                {tr("公开模型 ID")}
                <input
                  name="id"
                  readOnly={!!id}
                  placeholder={tr("自动生成")}
                  defaultValue={id || suggestedId}
                  pattern={"[a-zA-Z0-9][a-zA-Z0-9._\\-\\/]{0,127}"}
                />
              </label>
            </div>
          </details>
          <details className="full">
            <summary>{tr("模型能力")}</summary>
            <div className="form-grid">
              <ModelEndpoints value={model.operations} />
              <label>
                {tr("供应商")}
                <input name="provider" defaultValue={model.provider ?? ""} />
              </label>
              <label>
                {tr("上下文长度")}
                <input
                  name="contextWindow"
                  type="number"
                  min="1"
                  max="100000000"
                  step="1"
                  defaultValue={model.contextWindow ?? ""}
                />
              </label>
              <label className="full">
                {tr("支持的思考档位（逗号分隔）")}
                <input
                  name="reasoningEfforts"
                  defaultValue={model.reasoningEfforts?.join(",") ?? ""}
                />
              </label>
              <label className="full">
                {tr("模型描述")}
                <textarea
                  name="description"
                  rows={2}
                  maxLength={1024}
                  defaultValue={model.description ?? ""}
                />
              </label>
            </div>
          </details>
          <label className="checkbox full">
            <Checkbox
              appearance="switch"
              checked={enabled}
              onCheckedChange={(checked) => setEnabled(checked === true)}
            />
            {tr("启用模型")}
          </label>
        </div>
        <div className="modal-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={close}
          >
            {tr("取消")}
          </button>
          <button disabled={busy}>
            {busy ? tr("保存中…") : tr("保存并应用")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
