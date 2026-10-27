import type { UpstreamInterface } from "@pluhub/contracts/ai";
import type {
  WorkflowNode,
  WorkflowValueType,
} from "@pluhub/contracts/workflow";

export type { WorkflowValueType } from "@pluhub/contracts/workflow";
export type WorkflowParameter = {
  path: string;
  type: WorkflowValueType;
  label: string;
  sensitive?: boolean;
};
const param = (
  path: string,
  type: WorkflowValueType,
  label: string,
  sensitive = true,
): WorkflowParameter => ({ path, type, label, sensitive });

function interfaceParameters(
  prefix: string,
  interfaces?: UpstreamInterface[],
): WorkflowParameter[] {
  return (interfaces ?? []).flatMap((_, index) => {
    const path = `${prefix}.${index}.`;
    return [
      param(path + "incoming", "string[]", "入口接口"),
      param(path + "protocol", "string", "上游接口"),
      param(path + "models", "string[]", "匹配模型"),
      param(path + "path", "string", "接口路径"),
      param(path + "streamPath", "string", "流式接口路径"),
      param(path + "modelsPath", "string", "模型目录路径"),
      param(path + "auth.type", "string", "认证方式"),
      param(path + "auth.name", "string", "认证字段名"),
      param(path + "headers", "object", "请求头"),
      param(path + "params", "object", "请求参数"),
      param(path + "mediaPaths", "object", "媒体接口路径"),
    ];
  });
}

/** The shared list of editable, typed node parameters. Control-flow ports are separate. */
export function workflowParameters(
  node: WorkflowNode,
  personalInterfaces?: UpstreamInterface[],
  personal = false,
): WorkflowParameter[] {
  switch (node.type) {
    case "start":
      return [];
    case "text":
      return [param("text", "string", "文本", false)];
    case "format":
      return [param("value", "json", "值", false)];
    case "template":
      return [
        param("template", "string", "模板", false),
        ...Object.keys(node.values ?? {}).map((key) =>
          param(`values.${key}`, "string", key, false),
        ),
      ];
    case "replace":
      return [
        param("text", "string", "文本", false),
        param("find", "string", "查找内容", false),
        param("replacement", "string", "替换内容", false),
        param("all", "boolean", "全部替换", false),
      ];
    case "llm":
      return [
        param("model", "string", "模型", false),
        param("channelId", "string", "个人渠道"),
        param("allowedModels", "string[]", "允许的模型"),
        param("protocol", "string", "调用协议"),
        param("messages", "object", "消息", false),
        param("prompt", "string", "提示词", false),
        param("system", "string", "系统提示词", false),
        param("maxTokens", "integer", "最大输出 Token"),
        param("promptMode", "string", "提示词方式"),
      ];
    case "jev":
      return [
        param("model", "string", "模型"),
        param("channelId", "string", "个人渠道"),
        param("state", "json", "状态", false),
        param("questions", "object", "问题", false),
        param("assets", "object", "附件", false),
        param("answerKey", "string", "答案 ID", false),
      ];
    case "response":
      return [param("text", "string", "返回内容", false)];
    case "value":
      return [
        param(
          node.valueType === "secret" ? "secretRef" : "value",
          node.valueType,
          "值",
          node.valueType === "secret",
        ),
      ];
    case "condition":
    case "predicate":
      return [
        param("test", "string", "判断", false),
        param("modelSource", "string", "比较对象", false),
        param("models", "string[]", "模型 ID", false),
        param("protocol", "string", "入口协议", false),
        param("value", "integer", "字符数阈值", false),
      ];
    case "branch":
      return [param("condition", "boolean", "条件", false)];
    case "compare":
      return [
        param("left", node.valueType, "左侧", false),
        param("right", node.operator === "matches" ? "string[]" : node.valueType, "右侧", false),
      ];
    case "logic":
      return [
        param("left", "boolean", "条件", false),
        ...(node.operator === "not" ? [] : [param("right", "boolean", "条件", false)]),
      ];
    case "protocol":
      return [
        param("allow", "string[]", "允许的入口协议"),
        param("conversion", "string", "协议转换"),
      ];
    case "prompt":
      return [param("text", "string", "系统提示词", false)];
    case "reasoning":
      return [param("effort", "string", "思考强度", false)];
    case "maxTokens":
      return [param("limit", "integer", "最大输出 Token")];
    case "rateLimit":
      return [
        param("rule.rpm", "integer", "每分钟请求"),
        param("rule.tpm", "integer", "每分钟 Token"),
        param("rule.concurrency", "integer", "最大并发"),
        param("rule.bytesPerSecond", "integer", "响应字节 / 秒"),
      ];
    case "tps":
      return [
        param("rate", "number", "每请求 TPS"),
        param("tokenizer", "string", "分词器"),
        ...(!personal
          ? [
              param("aggregateRate", "number", "共享模型 TPS"),
              param("model", "string", "限定上游模型"),
              param("inheritDefault", "boolean", "同时应用默认 TPS"),
            ]
          : []),
      ];
    case "routing":
      return [param("profile", "string", "自动路由策略")];
    case "upstream":
      return [
        param("target", "string", "目标公开模型", false),
        param("allowedTargets", "string[]", "允许的目标模型"),
        param("mode", "string", "模型重定向"),
      ];
    case "platform":
      return [
        param("groupId", "string", "使用分组"),
        param("model", "string", "平台模型"),
      ];
    case "provider":
      return [
        param("recordResponseModel", "boolean", "记录上游响应模型"),
        ...(!personal
          ? [
              param("upstream.protocol", "string", "上游调用协议"),
              param("upstream.baseUrl", "string", "Base URL"),
              param("upstream.keyRef", "secret", "API Key"),
              param("upstream.subscriptionAccountIds", "string[]", "订阅账号"),
              param("upstream.authMode", "string", "订阅接入方式"),
              param("upstream.accountId", "string", "账号 ID"),
              param("upstream.projectId", "string", "项目 ID"),
              ...interfaceParameters(
                "upstream.interfaces",
                node.upstream?.interfaces,
              ),
            ]
          : interfaceParameters(
              "interfaces",
              personalInterfaces ?? node.interfaces,
            )),
        param("model", "string", "上游模型"),
      ];
  }
}

/** Data sources are explicit; values can fan out to any number of compatible inputs. */
export function workflowDataOutputs(node: WorkflowNode): WorkflowParameter[] {
  if (node.type === "text" || node.type === "format" || node.type === "template" || node.type === "replace")
    return [param("text", "string", "文本", false)];
  if (node.type === "llm")
    return [param("text", "string", "输出文本", false), param("usage", "object", "用量", false)];
  if (node.type === "jev")
    return [param("answers", "object", "答案", false), param("choice", "string", "选项", false), param("score", "number", "评分", false), param("noul", "number", "Noul", false), param("box", "object", "边界框", false), param("confidence", "number", "置信度", false)];
  if (node.type === "value")
    return [param("value", node.valueType, "值", false)];
  if (node.type === "predicate" || node.type === "compare" || node.type === "logic")
    return [param("result", "boolean", "结果", false)];
  if (node.type === "start")
    return [
      param("requestedModel", "string", "请求模型 ID", false),
      param("mappedModel", "string", "映射后的模型 ID", false),
      param("ingressProtocol", "string", "入口协议", false),
      param("stream", "boolean", "流式请求", false),
      param("hasTools", "boolean", "包含工具", false),
      param("textLength", "integer", "任务字符数", false),
      param("text", "string", "最近用户消息", false),
      param("messages", "object", "完整消息", false),
    ];
  return [];
}

export function compatibleWorkflowTypes(
  source: WorkflowValueType,
  target: WorkflowValueType,
) {
  return source === target || (source === "integer" && target === "number") ||
    (target === "json" && source !== "secret");
}
export function canBindWorkflowPorts(
  source: WorkflowNode,
  output: string,
  target: WorkflowNode,
  input: string,
  personalInterfaces?: UpstreamInterface[],
  personal = false,
) {
  const out = workflowDataOutputs(source).find(
    (field) => field.path === output,
  );
  const into = workflowParameters(target, personalInterfaces, personal).find(
    (field) => field.path === input,
  );
  return (
    !!out &&
    !!into &&
    compatibleWorkflowTypes(out.type, into.type) &&
    !( (source.type === "start" || source.type === "predicate" || source.type === "llm" || source.type === "jev") && into.sensitive)
  );
}
