import { Checkbox } from "./checkbox.js";
import { Select } from "./select.js";
import { t as tr } from "./i18n.js";
import { ProviderNodeSettings } from "./channel-provider-settings.js";
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
  platformGroups?: {
    data?: { id: string; name: string; multiplier: number }[];
  };
  platformNodes?: Extract<WorkflowNode, { type: "platform" }>[];
  channel: any;
  references?: { routingProfiles?: string[]; tokenizers?: string[] };
  personalInterfaces?: UpstreamInterface[];
  setPersonalInterfaces: (value: UpstreamInterface[] | undefined) => void;
  subscriptionAccounts: { data?: any[]; error?: string };
  targets: string[];
  onPanel: (panel: ChannelPanel) => void;
}
export function ChannelNodeSettings({
  node,
  change,
  context,
}: {
  node: WorkflowNode;
  change: (patch: any) => void;
  context: ChannelNodeContext;
}) {
  const { personal, references, targets, onPanel } = context;
  return (
    <>
      {node.type === "start" && !personal && (
        <button className="secondary" onClick={() => onPanel("limits")}>
          {tr("全局限制")}
        </button>
      )}
      {node.type === "condition" && (
        <>
          <label>
            {tr("判断")}
            <Select
              value={node.test}
              onChange={(e) =>
                change({
                  test: e.target.value,
                  protocol:
                    e.target.value === "protocol" ? "openai-chat" : undefined,
                })
              }
            >
              <option value="hasTools">{tr("包含工具")}</option>
              <option value="stream">{tr("流式请求")}</option>
              <option value="protocol">{tr("入口协议为")}</option>
              <option value="textLengthAbove">{tr("任务字符数大于")}</option>
            </Select>
          </label>
          {node.test === "protocol" && (
            <Select
              aria-label={tr("条件入口协议")}
              value={node.protocol ?? "openai-chat"}
              onChange={(e) => change({ protocol: e.target.value })}
            >
              {ingressOptions.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </Select>
          )}
          {node.test === "textLengthAbove" && (
            <input
              aria-label={tr("字符数阈值")}
              type="number"
              min="0"
              value={node.value ?? 0}
              onChange={(e) => change({ value: Number(e.target.value) })}
            />
          )}
        </>
      )}
      {node.type === "protocol" && (
        <fieldset>
          <legend>{tr("允许的入口协议")}</legend>
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
        </fieldset>
      )}
      {node.type === "prompt" && (
        <label>
          {tr("系统提示词")}
          <textarea
            rows={5}
            value={node.text}
            onChange={(e) => change({ text: e.target.value })}
          />
        </label>
      )}
      {node.type === "reasoning" && (
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
      )}
      {node.type === "maxTokens" && (
        <label>
          {tr("最大输出 Token")}
          <input
            type="number"
            min="1"
            value={node.limit}
            onChange={(e) => change({ limit: Number(e.target.value) })}
          />
        </label>
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
              <label key={key}>
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
            ))}
          </div>
        </fieldset>
      )}
      {node.type === "tps" && (
        <>
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
          {!personal && (
            <>
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
                    {context.platformGroups?.data?.find(
                      (group) => group.id === target.groupId,
                    )?.name ?? target.groupId}{" "}
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
          <label>
            {tr("使用分组")}
            <Select
              value={node.groupId}
              onChange={(e) => change({ groupId: e.target.value })}
            >
              <option value="" disabled>
                {tr("请选择分组")}
              </option>
              {context.platformGroups?.data?.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name} · ×{group.multiplier}
                </option>
              ))}
            </Select>
          </label>
          <label>
            {tr("平台模型")}
            <input
              value={node.model ?? ""}
              placeholder={tr("使用模型映射")}
              onChange={(e) => change({ model: e.target.value || undefined })}
            />
          </label>
          <p className="field-note">
            {tr("调用此节点会按平台分组价格扣除余额。")}
          </p>
        </>
      )}
      {node.type === "routing" && (
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
      )}
      {node.type === "upstream" && (
        <>
          <label>
            {tr("目标公开模型")}
            <input
              list={"workflow-models-" + node.id}
              value={node.target}
              onChange={(e) => change({ target: e.target.value })}
            />
          </label>
          <datalist id={"workflow-models-" + node.id}>
            {targets.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
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
        </>
      )}
    </>
  );
}
