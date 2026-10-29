import React from "react";
import { Checkbox } from "./checkbox.js";
import { Select } from "./select.js";
import { t as tr } from "./i18n.js";
import { ProviderNodeSettings } from "./channel-provider-settings.js";
import { FlowParameter } from "./flow-parameter-port.js";
import { SecretInput } from "./secret-input.js";
import {
  LinesField,
  WorkflowDataNodeSettings,
} from "./workflow-data-node-settings.js";
import type { WorkflowNode } from "@pluhub/contracts/workflow";
import type { UpstreamInterface, Protocol } from "@pluhub/contracts/ai";
import type { ChannelPanel } from "./channel-location.js";
export const ingressOptions: { value: Protocol; label: string }[] = [
  { value: "openai-chat", label: "OpenAI Chat Completions" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic", label: "Anthropic Messages" },
  { value: "gemini", label: "Gemini" },
];
export interface ChannelNodeContext {
  personal: boolean;
  platformChannels?: {
    data?: { id: string; name: string; scope: string }[];
  };
  platformNodes?: Extract<WorkflowNode, { type: "platform" }>[];
  channel: any;
  references?: { routingProfiles?: string[]; tokenizers?: string[] };
  personalInterfaces?: UpstreamInterface[];
  setPersonalInterfaces: (
    value: UpstreamInterface[] | undefined,
    remap?: readonly number[],
  ) => void;
  boundInputs: ReadonlySet<string>;
  hasInterfaceBindings: boolean;
  sourceHasBindings: boolean;
  subscriptionAccounts: { data?: any[]; error?: string };
  modelTargets: string[];
  providedModels: { id: string; model: string; name: string }[];
  personalChannels?: { id: string; name?: string }[];
  onPanel: (panel: ChannelPanel) => void;
}
export function ChannelNodeSettings({
  node,
  change,
  context,
}: {
  node: WorkflowNode;
  change: (patch: any, interfaceRemap?: readonly number[]) => void;
  context: ChannelNodeContext;
}) {
  const { personal, references, onPanel } = context;
  return (
    <>
      <WorkflowDataNodeSettings node={node} change={change} context={context} />
      {node.type === "value" && (
        <ValueNodeFields
          node={node}
          change={change}
          personal={personal}
          linked={context.sourceHasBindings}
        />
      )}
      {node.type === "branch" && (
        <FlowParameter field="condition" connectOnly>
          <label>{tr("条件输入")}</label>
        </FlowParameter>
      )}
      {node.type === "compare" && (
        <CompareNodeFields
          node={node}
          change={change}
          boundInputs={context.boundInputs}
        />
      )}
      {node.type === "logic" && (
        <LogicNodeFields
          node={node}
          change={change}
          boundInputs={context.boundInputs}
        />
      )}
      {node.type === "protocol" && (
        <fieldset>
          <legend>{tr("允许的入口协议")}</legend>
          <FlowParameter field="allow">
            <div>
              {ingressOptions.map((p) => (
                <label key={p.value}>
                  <Checkbox
                    checked={node.allow.includes(p.value)}
                    onCheckedChange={(e) =>
                      change({
                        allow:
                          e === true
                            ? [...node.allow, p.value]
                            : node.allow.filter((v) => v !== p.value),
                      })
                    }
                  />{" "}
                  {p.label}
                </label>
              ))}
            </div>
          </FlowParameter>
          <FlowParameter field="conversion">
            <label>
              {tr("协议转换")}
              <Select
                value={node.conversion}
                onChange={(e) => change({ conversion: e.target.value })}
              >
                <option value="auto">{tr("自动转换为上游协议")}</option>
                <option value="disabled">{tr("仅允许与上游相同的协议")}</option>
              </Select>
            </label>
          </FlowParameter>
        </fieldset>
      )}
      {node.type === "prompt" && (
        <FlowParameter field="text">
          <label>
            {tr("系统提示词")}
            <textarea
              rows={5}
              value={node.text}
              onChange={(e) => change({ text: e.target.value })}
            />
          </label>
        </FlowParameter>
      )}
      {node.type === "reasoning" && (
        <FlowParameter field="effort">
          <label>
            {tr("思考强度")}
            <Select
              value={node.effort}
              onChange={(e) => change({ effort: e.target.value })}
            >
              {["none", "minimal", "low", "medium", "high", "xhigh", "max"].map(
                (e) => (
                  <option key={e}>{e}</option>
                ),
              )}
            </Select>
          </label>
        </FlowParameter>
      )}
      {node.type === "maxTokens" && (
        <FlowParameter field="limit">
          <label>
            {tr("最大输出 Token")}
            <input
              type="number"
              min="1"
              value={node.limit}
              onChange={(e) => change({ limit: Number(e.target.value) })}
            />
          </label>
        </FlowParameter>
      )}
      {node.type === "rateLimit" && (
        <fieldset>
          <legend>{tr("当前渠道 · 经过此节点的请求")}</legend>
          <div className="form-grid">
            {[
              ["rpm", "每分钟请求"],
              ["tpm", "每分钟 Token"],
              ["concurrency", "最大并发"],
              ["bytesPerSecond", "响应字节 / 秒"],
            ].map(([key, title]) => (
              <FlowParameter key={key} field={"rule." + key}>
                <label>
                  {tr(title!)}
                  <input
                    type="number"
                    min="0"
                    max="1000000000"
                    step="1"
                    value={node.rule[key as keyof typeof node.rule] ?? ""}
                    onChange={(e) => {
                      const rule = { ...node.rule };
                      const value = Number(e.target.value);
                      if (value > 0) rule[key as keyof typeof rule] = value;
                      else delete rule[key as keyof typeof rule];
                      change({ rule });
                    }}
                  />
                </label>
              </FlowParameter>
            ))}
          </div>
        </fieldset>
      )}
      {node.type === "tps" && (
        <>
          <FlowParameter field="rate">
            <label>
              {tr("每请求 TPS")}
              <input
                type="number"
                min="0.1"
                step="0.1"
                value={node.rate ?? ""}
                onChange={(e) =>
                  change({
                    rate: Number(e.target.value) || undefined,
                  })
                }
              />
            </label>
          </FlowParameter>
          <FlowParameter field="tokenizer">
            <label>
              {tr("分词器")}
              <Select
                value={node.tokenizer}
                onChange={(e) => change({ tokenizer: e.target.value })}
              >
                <option>o200k_base</option>
                <option>cl100k_base</option>
                {!personal &&
                  (references?.tokenizers ?? []).map((name: string) => (
                    <option key={name}>{name}</option>
                  ))}
              </Select>
            </label>
          </FlowParameter>
          {!personal && (
            <>
              <FlowParameter field="aggregateRate">
                <label>
                  {tr("共享模型 TPS")}
                  <input
                    type="number"
                    min="0.1"
                    step="0.1"
                    value={node.aggregateRate ?? ""}
                    onChange={(e) =>
                      change({
                        aggregateRate: Number(e.target.value) || undefined,
                      })
                    }
                  />
                </label>
              </FlowParameter>
              <FlowParameter field="model">
                <label>
                  {tr("限定上游模型")}
                  <input
                    value={node.model ?? ""}
                    placeholder={tr("全部模型")}
                    onChange={(e) =>
                      change({ model: e.target.value || undefined })
                    }
                  />
                </label>
              </FlowParameter>
              <FlowParameter field="inheritDefault">
                <label>
                  <Checkbox
                    appearance="switch"
                    checked={node.inheritDefault !== false}
                    onCheckedChange={(e) =>
                      change({ inheritDefault: e === true })
                    }
                  />{" "}
                  {tr("同时应用默认 TPS")}
                </label>
              </FlowParameter>
            </>
          )}
        </>
      )}
      {node.type === "provider" && (
        <>
          <ProviderNodeSettings node={node} change={change} context={context} />
          {personal && (
            <label>
              {tr("失败后切换")}
              <Select
                value={node.fallback ?? ""}
                onChange={(e) =>
                  change({ fallback: e.target.value || undefined })
                }
              >
                <option value="">{tr("不切换")}</option>
                {context.platformNodes?.map((target) => (
                  <option key={target.id} value={target.id}>
                    {context.platformChannels?.data?.find(
                      (channel) => channel.id === target.channelId,
                    )?.name ?? target.channelId}{" "}
                    · {target.model || tr("使用模型映射")}
                  </option>
                ))}
              </Select>
            </label>
          )}
        </>
      )}
      {node.type === "platform" && (
        <>
          <FlowParameter field="channelId">
            <label>
              {tr("平台渠道")}
              <Select
                value={node.channelId}
                onChange={(e) => change({ channelId: e.target.value })}
              >
                <option value="" disabled>
                  {tr("请选择渠道")}
                </option>
                {context.platformChannels?.data?.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {channel.name}
                  </option>
                ))}
              </Select>
            </label>
          </FlowParameter>
          <FlowParameter field="model">
            <label>
              {tr("平台模型")}
              <input
                value={node.model ?? ""}
                placeholder={tr("使用模型映射")}
                onChange={(e) => change({ model: e.target.value || undefined })}
              />
            </label>
          </FlowParameter>
        </>
      )}
      {node.type === "routing" && (
        <FlowParameter field="profile">
          <label>
            {tr("自动路由策略")}
            <input
              list={"routing-profiles-" + node.id}
              value={node.profile}
              onChange={(e) => change({ profile: e.target.value })}
            />
            <datalist id={"routing-profiles-" + node.id}>
              <option value="$model">{tr("使用模型映射中的策略 ID")}</option>
              {(references?.routingProfiles ?? []).map((id: string) => (
                <option key={id}>{id}</option>
              ))}
            </datalist>
            <button className="secondary" onClick={() => onPanel("routing")}>
              {tr("编辑路由策略")}
            </button>
          </label>
        </FlowParameter>
      )}
      {node.type === "upstream" && (
        <>
          <FlowParameter field="target">
            <label>
              {tr("目标公开模型")}
              <input
                list={"workflow-models-" + node.id}
                value={node.target}
                onChange={(e) => change({ target: e.target.value })}
              />
            </label>
          </FlowParameter>
          <datalist id={"workflow-models-" + node.id}>
            {context.modelTargets.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          <FlowParameter field="allowedTargets">
            <label>
              {tr("允许选择的模型")}
              <LinesField
                value={node.allowedTargets ?? []}
                onChange={(allowedTargets) => change({ allowedTargets })}
              />
            </label>
          </FlowParameter>
          <FlowParameter field="mode">
            <label>
              {tr("模型重定向")}
              <Select
                value={node.mode}
                onChange={(e) => change({ mode: e.target.value })}
              >
                <option value="implicit">{tr("隐式 · 保持请求模型名")}</option>
                <option value="explicit">{tr("显式 · 显示目标模型名")}</option>
              </Select>
            </label>
          </FlowParameter>
        </>
      )}
    </>
  );
}

function ValueNodeFields({
  node,
  change,
  personal,
  linked,
}: {
  node: Extract<WorkflowNode, { type: "value" }>;
  change: (patch: any) => void;
  personal: boolean;
  linked: boolean;
}) {
  const type = node.valueType;
  const [text, setText] = React.useState(() =>
    type === "string[]"
      ? ((node.value ?? []) as string[]).join("\n")
      : JSON.stringify(node.value ?? {}, null, 2),
  );
  const [invalid, setInvalid] = React.useState(false);
  const field = React.useRef<HTMLTextAreaElement>(null);
  const signature = JSON.stringify(node.value);
  const parse = (value: string) =>
    type === "string[]"
      ? value
          .split(/\r?\n/)
          .map((item) => item.trim())
          .filter(Boolean)
      : JSON.parse(value);
  React.useEffect(() => {
    try {
      if (JSON.stringify(parse(text)) === signature) return;
    } catch {}
    setText(
      type === "string[]"
        ? ((node.value ?? []) as string[]).join("\n")
        : JSON.stringify(node.value ?? {}, null, 2),
    );
    setInvalid(false);
    field.current?.setCustomValidity("");
  }, [signature, type]);
  const types = [
    ["integer", "整数"],
    ["number", "数值"],
    ["string", "文本"],
    ["boolean", "布尔值"],
    ["string[]", "文本列表"],
    ["object", "结构化数据"],
    ...(!personal ? [["secret", "密钥"]] : []),
  ];
  return (
    <>
      <label>
        {tr("数据类型")}
        <Select
          value={type}
          disabled={linked}
          title={linked ? tr("请先断开此节点的数据连接") : undefined}
          onChange={(e) => {
            const valueType = e.target.value;
            const value =
              valueType === "integer" || valueType === "number"
                ? 1
                : valueType === "boolean"
                  ? false
                  : valueType === "string[]"
                    ? []
                    : valueType === "object"
                      ? {}
                      : "";
            change({
              valueType,
              value: valueType === "secret" ? undefined : value,
              secretRef: valueType === "secret" ? "" : undefined,
            });
          }}
        >
          {types.map(([value, label]) => (
            <option key={value} value={value}>
              {tr(label!)}
            </option>
          ))}
        </Select>
      </label>
      {type === "secret" ? (
        <FlowParameter field="secretRef">
          <label>
            {tr("密钥")}
            <SecretInput
              multiline
              value={node.secretRef}
              onChange={(secretRef) => change({ secretRef })}
            />
          </label>
        </FlowParameter>
      ) : (
        <FlowParameter field="value">
          <label>
            {tr("值")}
            {type === "boolean" ? (
              <Checkbox
                checked={node.value === true}
                onCheckedChange={(value) => change({ value: value === true })}
              />
            ) : type === "string[]" || type === "object" ? (
              <>
                <textarea
                  ref={field}
                  rows={4}
                  aria-invalid={invalid || undefined}
                  value={text}
                  onChange={(event) => {
                    const next = event.target.value;
                    setText(next);
                    try {
                      const value = parse(next);
                      if (
                        type === "object" &&
                        (!value || typeof value !== "object")
                      )
                        throw Error();
                      field.current?.setCustomValidity("");
                      setInvalid(false);
                      change({ value });
                    } catch {
                      field.current?.setCustomValidity(
                        tr("请输入有效的 JSON 对象或数组"),
                      );
                      setInvalid(true);
                    }
                  }}
                />
                {invalid && (
                  <span className="field-note" role="alert">
                    {tr("请输入有效的 JSON 对象或数组")}
                  </span>
                )}
              </>
            ) : (
              <input
                type={type === "string" ? "text" : "number"}
                step={type === "integer" ? "1" : "any"}
                value={
                  (node.value as string | number | undefined) ??
                  (type === "string" ? "" : 0)
                }
                onChange={(event) =>
                  change({
                    value:
                      type === "string"
                        ? event.target.value
                        : Number(event.target.value),
                  })
                }
              />
            )}
          </label>
        </FlowParameter>
      )}
    </>
  );
}

function CompareNodeFields({
  node,
  change,
  boundInputs,
}: {
  node: Extract<WorkflowNode, { type: "compare" }>;
  change: (patch: any) => void;
  boundInputs: ReadonlySet<string>;
}) {
  const inputBound = boundInputs.has("left") || boundInputs.has("right");
  const rightBound = boundInputs.has("right");
  const initial = (type: string) =>
    type === "number" ? 0 : type === "boolean" ? false : "";
  const operators = [
    ["eq", "等于"],
    ["ne", "不等于"],
    ...(node.valueType === "number"
      ? [
          ["gt", "大于"],
          ["gte", "大于或等于"],
          ["lt", "小于"],
          ["lte", "小于或等于"],
        ]
      : []),
    ...(node.valueType === "string" ? [["matches", "匹配规则"]] : []),
  ];
  return (
    <>
      <label>
        {tr("数据类型")}
        <Select
          value={node.valueType}
          disabled={inputBound}
          title={inputBound ? tr("请先断开此节点的数据连接") : undefined}
          onChange={(event) => {
            const valueType = event.target.value;
            const value = initial(valueType);
            change({ valueType, operator: "eq", left: value, right: value });
          }}
        >
          <option value="string">{tr("文本")}</option>
          <option value="number">{tr("数值")}</option>
          <option value="boolean">{tr("布尔值")}</option>
        </Select>
      </label>
      <label>
        {tr("比较方式")}
        <Select
          value={node.operator}
          disabled={rightBound}
          title={rightBound ? tr("请先断开此节点的数据连接") : undefined}
          onChange={(event) => {
            const operator = event.target.value;
            const changingType =
              (operator === "matches") !== (node.operator === "matches");
            change({
              operator,
              ...(changingType
                ? {
                    right:
                      operator === "matches" ? [] : initial(node.valueType),
                  }
                : {}),
            });
          }}
        >
          {operators.map(([value, label]) => (
            <option key={value} value={value}>
              {tr(label!)}
            </option>
          ))}
        </Select>
      </label>
      <CompareInput
        field="left"
        label="左值"
        type={node.valueType}
        value={node.left}
        change={change}
      />
      <CompareInput
        field="right"
        label={
          node.operator === "matches" ? "匹配规则（每行一个，可用 *）" : "右值"
        }
        type={node.operator === "matches" ? "string[]" : node.valueType}
        value={node.right}
        change={change}
      />
    </>
  );
}

function CompareInput({
  field,
  label,
  type,
  value,
  change,
}: {
  field: "left" | "right";
  label: string;
  type: "string" | "number" | "boolean" | "string[]";
  value: string | number | boolean | string[];
  change: (patch: any) => void;
}) {
  const [text, setText] = React.useState(() =>
    Array.isArray(value) ? value.join("\n") : "",
  );
  const signature = JSON.stringify(value);
  const parse = (input: string) =>
    input
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
  React.useEffect(() => {
    if (Array.isArray(value) && JSON.stringify(parse(text)) !== signature)
      setText(value.join("\n"));
  }, [signature, type]);
  return (
    <FlowParameter field={field}>
      <label>
        {type === "boolean" ? (
          <>
            <Checkbox
              checked={value === true}
              onCheckedChange={(next) => change({ [field]: next === true })}
            />{" "}
            {tr(label)}
          </>
        ) : type === "string[]" ? (
          <>
            {tr(label)}
            <textarea
              rows={3}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                change({ [field]: parse(event.target.value) });
              }}
            />
          </>
        ) : (
          <>
            {tr(label)}
            <input
              type={type === "number" ? "number" : "text"}
              step={type === "number" ? "any" : undefined}
              value={
                typeof value === "string" || typeof value === "number"
                  ? value
                  : ""
              }
              onChange={(event) =>
                change({
                  [field]:
                    type === "number"
                      ? Number(event.target.value)
                      : event.target.value,
                })
              }
            />
          </>
        )}
      </label>
    </FlowParameter>
  );
}

function LogicNodeFields({
  node,
  change,
  boundInputs,
}: {
  node: Extract<WorkflowNode, { type: "logic" }>;
  change: (patch: any) => void;
  boundInputs: ReadonlySet<string>;
}) {
  return (
    <>
      <label>
        {tr("逻辑运算")}
        <Select
          value={node.operator}
          onChange={(event) => {
            const operator = event.target.value;
            change({
              operator,
              right: operator === "not" ? undefined : (node.right ?? false),
            });
          }}
        >
          <option value="and">{tr("且")}</option>
          <option value="or">{tr("或")}</option>
          <option value="not" disabled={boundInputs.has("right")}>
            {tr("非")}
          </option>
        </Select>
      </label>
      <FlowParameter field="left">
        <label>
          <Checkbox
            checked={node.left}
            onCheckedChange={(value) => change({ left: value === true })}
          />{" "}
          {tr("左值")}
        </label>
      </FlowParameter>
      {node.operator !== "not" && (
        <FlowParameter field="right">
          <label>
            <Checkbox
              checked={node.right === true}
              onCheckedChange={(value) => change({ right: value === true })}
            />{" "}
            {tr("右值")}
          </label>
        </FlowParameter>
      )}
    </>
  );
}
