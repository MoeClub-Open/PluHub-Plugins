import React from "react";
import type { WorkflowNode } from "@pluhub/contracts/workflow";
import type { ChannelNodeContext } from "./channel-node-settings.js";
import { Checkbox } from "./checkbox.js";
import { FlowParameter } from "./flow-parameter-port.js";
import { Select } from "./select.js";
import { t as tr } from "./i18n.js";

/** Edits JSON without discarding an unfinished value while the user types. */
function JsonField({ value, onChange, label, objectOnly = false, stateOnly = false }: {
  value: unknown;
  onChange: (value: any) => void;
  label: string;
  objectOnly?: boolean;
  stateOnly?: boolean;
}) {
  const serialized = JSON.stringify(value === undefined ? {} : value, null, 2);
  const applied = React.useRef(serialized);
  const [text, setText] = React.useState(serialized);
  const [error, setError] = React.useState("");
  const field = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => {
    if (serialized === applied.current) return;
    applied.current = serialized;
    setText(serialized);
    setError("");
    field.current?.setCustomValidity("");
  }, [serialized]);
  return <>
    <textarea
      ref={field}
      aria-label={tr(label)}
      aria-invalid={!!error}
      value={text}
      rows={5}
      spellCheck={false}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        try {
          const parsed = JSON.parse(next);
          if (objectOnly && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) throw new Error();
          if (stateOnly && (parsed === null || !["object", "string"].includes(typeof parsed))) throw new Error(tr("支持文本、对象或数组"));
          applied.current = JSON.stringify(parsed, null, 2);
          event.target.setCustomValidity("");
          setError("");
          onChange(parsed);
        } catch (cause) {
          const message = cause instanceof Error && !(cause instanceof SyntaxError) && cause.message ? cause.message : tr("JSON 格式无效");
          event.target.setCustomValidity(message);
          setError(message);
        }
      }}
    />
    {error && <span className="danger-text" role="alert">{error}</span>}
  </>;
}

export function LinesField({ value, onChange }: { value: string[]; onChange: (value: string[]) => void }) {
  const serialized = JSON.stringify(value);
  const applied = React.useRef(serialized);
  const [text, setText] = React.useState(value.join("\n"));
  React.useEffect(() => {
    if (serialized === applied.current) return;
    applied.current = serialized;
    setText(value.join("\n"));
  }, [serialized]);
  return <textarea rows={2} value={text} onChange={(event) => {
    const next = event.target.value;
    const values = next.split("\n").map((item) => item.trim()).filter(Boolean);
    setText(next);
    applied.current = JSON.stringify(values);
    onChange(values);
  }} />;
}

function TemplateFields({ node, change, boundInputs }: {
  node: any;
  change: (patch: any) => void;
  boundInputs: ReadonlySet<string>;
}) {
  const [name, setName] = React.useState("");
  const values: Record<string, string> = node.values ?? {};
  const validName = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !Object.hasOwn(values, name);
  return <>
    <FlowParameter field="template">
      <label>{tr("模板内容")}
        <textarea value={node.template ?? ""} rows={4} onChange={(event) => change({ template: event.target.value })} />
      </label>
    </FlowParameter>
    {Object.entries(values).map(([key, value]) => <FlowParameter key={key} field={"values." + key}>
      <label>{"{{" + key + "}}"}
        <textarea value={value} rows={2} onChange={(event) => change({ values: { ...values, [key]: event.target.value } })} />
      </label>
      <button type="button" className="secondary" disabled={boundInputs.has("values." + key)} onClick={() => {
        const next = { ...values };
        delete next[key];
        change({ values: next });
      }}>{tr("删除变量")}</button>
    </FlowParameter>)}
    <div className="inline-fields">
      <input aria-label={tr("变量名")} value={name} onChange={(event) => setName(event.target.value)} />
      <button type="button" className="secondary" disabled={!validName} onClick={() => {
        change({ values: { ...values, [name]: "" } });
        setName("");
      }}>{tr("添加变量")}</button>
    </div>
  </>;
}

function JevChoiceEditor({ questions, answerKey, change }: {
  questions: Record<string, any>;
  answerKey?: string;
  change: (patch: any) => void;
}) {
  const keys = Object.keys(questions);
  const key = answerKey && questions[answerKey] ? answerKey : keys[0];
  const question = key ? questions[key] : undefined;
  const simple = keys.length === 1 && question?.type === "choice" &&
    typeof question.instructions === "string" && question.criteria &&
    Object.values(question.criteria).every((value) => typeof value === "string");
  const lines = simple ? Object.entries(question.criteria).map(([name, description]) =>
    name === description ? name : `${name} | ${description}`,
  ).join("\n") : "";
  const [options, setOptions] = React.useState(lines);
  React.useEffect(() => setOptions(lines), [lines]);
  if (!simple || !key) return null;
  return <>
    <label>{tr("问题说明")}
      <textarea rows={2} value={question.instructions} onChange={(event) => change({
        questions: { ...questions, [key]: { ...question, instructions: event.target.value } },
      })} />
    </label>
    <label>{tr("选项及说明")}
      <textarea rows={4} value={options} placeholder={"simple | 简单问题\ncomplex | 复杂问题"}
        onChange={(event) => setOptions(event.target.value)} onBlur={() => {
          const criteria = Object.fromEntries(options.split("\n").map((line) => {
            const [name, ...description] = line.split("|");
            return [name!.trim(), description.join("|").trim() || name!.trim()];
          }).filter(([name]) => !!name));
          change({ questions: { ...questions, [key]: { ...question, criteria } }, answerKey: key });
        }} />
    </label>
  </>;
}

/** Settings for the data-producing nodes and the explicit text response. */
export function WorkflowDataNodeSettings({ node, change, context }: {
  node: WorkflowNode;
  change: (patch: any) => void;
  context: ChannelNodeContext;
}) {
  // Kept local to this component so new node types do not affect the existing settings UI.
  const item = node as any;
  switch (item.type) {
    case "text":
      return <FlowParameter field="text"><label>{tr("文本内容")}
        <textarea rows={4} value={item.text ?? ""} onChange={(event) => change({ text: event.target.value })} />
      </label></FlowParameter>;
    case "format":
      return <FlowParameter field="value"><label>{tr("待转换内容")}
        <JsonField label="待转换内容" value={item.value} onChange={(value) => change({ value })} />
      </label></FlowParameter>;
    case "template":
      return <TemplateFields node={item} change={change} boundInputs={context.boundInputs} />;
    case "replace":
      return <>
        <FlowParameter field="text"><label>{tr("原文本")}
          <textarea rows={3} value={item.text ?? ""} onChange={(event) => change({ text: event.target.value })} />
        </label></FlowParameter>
        <FlowParameter field="find"><label>{tr("查找内容")}
          <input value={item.find ?? ""} onChange={(event) => change({ find: event.target.value })} />
        </label></FlowParameter>
        <FlowParameter field="replacement"><label>{tr("替换为")}
          <input value={item.replacement ?? ""} onChange={(event) => change({ replacement: event.target.value })} />
        </label></FlowParameter>
        <FlowParameter field="all"><label className="checkbox-row">
          <Checkbox checked={item.all === true} onCheckedChange={(value) => change({ all: value === true })} /> {tr("替换全部")}
        </label></FlowParameter>
      </>;
    case "llm":
      return <>
        <FlowParameter field="model"><label>{tr("模型")}
          <input list={"flow-models-" + item.id} value={item.model ?? ""} onChange={(event) => change({ model: event.target.value })} />
          <datalist id={"flow-models-" + item.id}>{context.modelTargets.map((target) => <option key={target} value={target} />)}</datalist>
        </label></FlowParameter>
        <FlowParameter field="channelId"><label>{tr("个人渠道（可选）")}
          <Select value={item.channelId ?? ""} onChange={(event) => change({ channelId: event.target.value || undefined })}>
            <option value="">{tr("自动选择")}</option>
            {item.channelId && !context.personalChannels?.some((channel) => channel.id === item.channelId) && <option value={item.channelId} disabled>{item.channelId}</option>}
            {(context.personalChannels ?? []).map((channel) => <option key={channel.id} value={channel.id}>{channel.name || channel.id}</option>)}
          </Select>
        </label></FlowParameter>
        <FlowParameter field="allowedModels"><label>{tr("允许选择的模型")}
          <LinesField value={item.allowedModels ?? []} onChange={(value) => change({ allowedModels: value })} />
        </label></FlowParameter>
        <FlowParameter field="protocol"><label>{tr("请求协议")}
          <Select value={item.protocol ?? ""} onChange={(event) => change({ protocol: event.target.value || undefined })}>
            <option value="">{tr("自动")}</option>
            <option value="openai-chat">OpenAI Chat Completions</option>
            <option value="openai-responses">OpenAI Responses</option>
            <option value="anthropic">Anthropic Messages</option>
          </Select>
        </label></FlowParameter>
        <FlowParameter field="promptMode"><label>{tr("提示词处理")}
          <Select value={item.promptMode ?? "append"} onChange={(event) => change({ promptMode: event.target.value })}>
            <option value="append">{tr("追加到对话")}</option>
            <option value="replace">{tr("替换对话")}</option>
          </Select>
        </label></FlowParameter>
        <FlowParameter field="prompt"><label>{tr("提示词")}
          <textarea rows={4} value={item.prompt ?? ""} onChange={(event) => change({ prompt: event.target.value })} />
        </label></FlowParameter>
        <FlowParameter field="system"><label>{tr("系统提示词")}
          <textarea rows={3} value={item.system ?? ""} onChange={(event) => change({ system: event.target.value || undefined })} />
        </label></FlowParameter>
        <FlowParameter field="messages"><details><summary>{tr("自定义消息")}</summary>
          {item.messages === undefined ? <button type="button" className="secondary" onClick={() => change({ messages: [] })}>{tr("编辑消息")}</button> : <>
            <JsonField label="消息 JSON" value={item.messages} onChange={(value) => change({ messages: value })} />
            <button type="button" className="secondary" onClick={() => change({ messages: undefined })}>{tr("使用原始对话")}</button>
          </>}
        </details></FlowParameter>
        <FlowParameter field="maxTokens"><label>{tr("最大输出 Token")}
          <input type="number" min="1" value={item.maxTokens ?? ""} onChange={(event) => change({ maxTokens: event.target.value ? Number(event.target.value) : undefined })} />
        </label></FlowParameter>
      </>;
    case "jev":
      return <>
        <FlowParameter field="model"><label>{tr("模型")}
          <input list={"flow-jev-models-" + item.id} value={item.model ?? ""} onChange={(event) => change({ model: event.target.value })} />
          <datalist id={"flow-jev-models-" + item.id}>{context.modelTargets.map((target) => <option key={target} value={target} />)}</datalist>
        </label></FlowParameter>
        <FlowParameter field="channelId"><label>{tr("个人渠道（可选）")}
          <Select value={item.channelId ?? ""} onChange={(event) => change({ channelId: event.target.value || undefined })}>
            <option value="">{tr("自动选择")}</option>
            {item.channelId && !context.personalChannels?.some((channel) => channel.id === item.channelId) && <option value={item.channelId} disabled>{item.channelId}</option>}
            {(context.personalChannels ?? []).map((channel) => <option key={channel.id} value={channel.id}>{channel.name || channel.id}</option>)}
          </Select>
        </label></FlowParameter>
        <FlowParameter field="state"><label>{tr("待判断内容")}
          {typeof item.state === "string" ? <textarea rows={4} value={item.state} onChange={(event) => change({ state: event.target.value })} /> :
            <JsonField label="待判断内容" value={item.state} stateOnly onChange={(value) => change({ state: value })} />}
        </label>
          <Select aria-label={tr("内容类型")} value={typeof item.state === "string" ? "text" : "json"} onChange={(event) => change({ state: event.target.value === "text" ? "" : {} })}>
            <option value="text">{tr("文本")}</option><option value="json">JSON</option>
          </Select>
          <small>{tr("支持文本、对象或数组")}</small>
        </FlowParameter>
        <FlowParameter field="questions">
          <JevChoiceEditor questions={item.questions ?? {}} answerKey={item.answerKey} change={change} />
          <details><summary>{tr("问题 JSON")}</summary>
            <JsonField label="判断问题" value={item.questions} objectOnly onChange={(value) => change({ questions: value })} />
          </details>
        </FlowParameter>
        <FlowParameter field="assets"><details><summary>{tr("附件")}</summary>
          <JsonField label="附件 JSON" value={item.assets ?? {}} objectOnly onChange={(value) => change({ assets: value })} />
        </details></FlowParameter>
        <FlowParameter field="answerKey"><label>{tr("结果问题 ID")}
          <input value={item.answerKey ?? ""} onChange={(event) => change({ answerKey: event.target.value || undefined })} />
        </label></FlowParameter>
      </>;
    case "response":
      return <FlowParameter field="text"><label>{tr("返回内容")}
        <textarea rows={4} value={item.text ?? ""} onChange={(event) => change({ text: event.target.value })} />
      </label></FlowParameter>;
    default:
      return null;
  }
}
