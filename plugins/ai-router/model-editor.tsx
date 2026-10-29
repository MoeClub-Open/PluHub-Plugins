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
  mode,
  providerModel,
  save,
  close,
}: {
  id?: string;
  suggestedId: string;
  model: ModelRoute;
  upstreams: Record<string, Upstream>;
  mode: "offer" | "price";
  providerModel?: string;
  save: (
    id: string,
    model: ModelRoute,
    providerModel?: string,
  ) => Promise<void>;
  close: () => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [enabled, setEnabled] = React.useState(model.enabled !== false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? "").trim();
    const next: ModelRoute = { ...model };
    if (mode === "price") {
      for (const field of ["inputPrice", "outputPrice"] as const) {
        if (text(field)) next[field] = Number(text(field));
        else delete next[field];
      }
      next.pricing = readModelPricing(form);
      if (!next.pricing) delete next.pricing;
    } else {
      next.model = model.model || text("publicModel");
      next.publicModel = text("publicModel");
      next.enabled = enabled;
      if (text("visibility")) next.visibility = text("visibility") as ModelRoute["visibility"];
      else delete next.visibility;
      next.operations = form.getAll("operations") as ModelRoute["operations"];
      for (const field of ["name", "provider", "description"] as const) {
        if (text(field)) next[field] = text(field);
        else delete next[field];
      }
      for (const field of ["contextWindow"] as const) {
        if (text(field)) next[field] = Number(text(field));
        else delete next[field];
      }
      if (text("reasoningEfforts"))
        next.reasoningEfforts = text("reasoningEfforts")
          .split(",")
          .map((value) => value.trim()) as ModelRoute["reasoningEfforts"];
      else delete next.reasoningEfforts;
    }
    setBusy(true);
    setMessage("");
    try {
      await save(
        id || suggestedId,
        next,
        mode === "offer" && providerModel !== undefined
          ? text("providerModel")
          : undefined,
      );
      close();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={
        mode === "price"
          ? tr("模型定价")
          : id
            ? tr("编辑提供模型")
            : tr("添加模型")
      }
      close={() => {
        if (!busy) close();
      }}
    >
      <form onSubmit={submit}>
        <Notice message={message} />
        {model.model && (
          <p>
            <strong>{model.name || model.publicModel || model.model}</strong>
            <small>{upstreams[model.upstream]?.name || model.upstream}</small>
          </p>
        )}
        <div className="form-grid">
          {mode === "price" ? (
            <ModelPriceFields model={model} />
          ) : (
            <>
              <label className="full">
                {tr("显示名称")}
                <input
                  name="name"
                  defaultValue={model.name ?? ""}
                  maxLength={128}
                />
              </label>
              <label className="full">
                {tr("公开模型名")}
                <input
                  name="publicModel"
                  required
                  maxLength={256}
                  defaultValue={model.publicModel ?? id ?? suggestedId}
                />
              </label>
              {providerModel !== undefined && (
                <label className="full">
                  {tr("上游模型 ID")}
                  <input
                    name="providerModel"
                    required
                    defaultValue={providerModel}
                  />
                </label>
              )}
              <label className="full">
                {tr("模型可见范围")}
                <Select name="visibility" defaultValue={model.visibility ?? ""}>
                  <option value="">{tr("所有人")}</option>
                  <option value="authenticated">{tr("已登录用户")}</option>
                  <option value="consumed">{tr("已消费用户")}</option>
                  <option value="paid">{tr("已付款用户")}</option>
                </Select>
              </label>
              <details className="full">
                <summary>{tr("模型能力")}</summary>
                <div className="form-grid">
                  <ModelEndpoints value={model.operations} />
                  <label>
                    {tr("供应商")}
                    <input
                      name="provider"
                      defaultValue={model.provider ?? ""}
                    />
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
            </>
          )}
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
