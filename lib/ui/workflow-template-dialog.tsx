import React from "react";
import type { ChannelWorkflow } from "@pluhub/contracts/workflow";
import { Dialog } from "./components.js";
import { Select } from "./select.js";
import { t as tr } from "./i18n.js";
import { createWorkflowTemplate, workflowTemplates, type WorkflowTemplateId, type WorkflowTemplateModel } from "./workflow-templates.js";

export function WorkflowTemplateDialog({ targets, onApply, close, disabled = false }: {
  targets: string[];
  onApply: (flow: ChannelWorkflow) => void;
  close: () => void;
  disabled?: boolean;
}) {
  const [id, setId] = React.useState<WorkflowTemplateId>(workflowTemplates[0]!.id);
  const [models, setModels] = React.useState<Partial<Record<WorkflowTemplateModel, string>>>({});
  const [find, setFind] = React.useState("");
  const [replacement, setReplacement] = React.useState("");
  const template = workflowTemplates.find((item) => item.id === id)!;
  const ready = template.models.every((item) => !!models[item.key] && targets.includes(models[item.key]!)) &&
    (id !== "output-processing" || !!find);
  return <Dialog title={tr("流程模板")} close={close}>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (disabled || !ready) return;
      onApply(createWorkflowTemplate(id, models, { find, replacement }));
      close();
    }}>
      <label>{tr("模板")}
        <Select value={id} onChange={(event) => setId(event.target.value as WorkflowTemplateId)}>
          {workflowTemplates.map((item) => <option key={item.id} value={item.id}>{tr(item.label)}</option>)}
        </Select>
      </label>
      {template.models.map((item) => <label key={item.key}>{tr(item.label)}
        <Select value={models[item.key] ?? ""} onChange={(event) => setModels({ ...models, [item.key]: event.target.value })}>
          <option value="">{tr("选择模型")}</option>
          {targets.map((target) => <option key={target} value={target}>{target}</option>)}
        </Select>
      </label>)}
      {id === "output-processing" && <>
        <label>{tr("查找内容")}<input required value={find} onChange={(event) => setFind(event.target.value)} /></label>
        <label>{tr("替换为")}<input value={replacement} onChange={(event) => setReplacement(event.target.value)} /></label>
      </>}
      <p className="field-note">{tr("应用模板会替换当前流程，可使用撤销恢复。")}</p>
      <div className="actions">
        <button type="button" className="secondary" onClick={close}>{tr("取消")}</button>
        <button type="submit" disabled={disabled || !ready}>{tr("应用模板")}</button>
      </div>
    </form>
  </Dialog>;
}
