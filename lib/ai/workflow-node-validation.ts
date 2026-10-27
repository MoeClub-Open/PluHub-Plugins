import { HostError } from "@pluhub/sdk";
import type { WorkflowNode } from "@pluhub/contracts/workflow";

const names = (value: unknown) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((item) => typeof item === "string" && item.trim());
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Validate the editable values of data and response nodes after bindings resolve. */
export function validateWorkflowDataNode(node: WorkflowNode, bound = new Set<string>()): void {
  const bad = (message: string): never => {
    throw new HostError("invalid_workflow", `${message}：${node.id}`, 400);
  };
  const check = (path: string, valid: boolean, message: string) => {
    if (!valid && !bound.has(path)) bad(message);
  };
  switch (node.type) {
    case "text":
    case "response":
      check("text", typeof node.text === "string", "文本无效");
      return;
    case "format":
      check("value", node.value !== undefined, "待转换内容无效");
      return;
    case "template":
      check("template", typeof node.template === "string", "模板无效");
      if (!record(node.values)) bad("模板变量无效");
      for (const [key, value] of Object.entries(node.values)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) ||
            ["__proto__", "prototype", "constructor"].includes(key))
          bad("模板变量名无效");
        check(`values.${key}`, typeof value === "string", "模板变量无效");
      }
      return;
    case "replace":
      check("text", typeof node.text === "string", "文本无效");
      check("find", typeof node.find === "string" && node.find.length > 0, "查找内容不能为空");
      check("replacement", typeof node.replacement === "string", "替换内容无效");
      check("all", typeof node.all === "boolean", "替换方式无效");
      return;
    case "llm":
      check("model", typeof node.model === "string" && !!node.model.trim(), "请选择模型");
      check("channelId", node.channelId === undefined || (typeof node.channelId === "string" && !!node.channelId.trim()), "个人渠道无效");
      if (node.allowedModels !== undefined && !names(node.allowedModels)) bad("允许的模型无效");
      check("protocol", node.protocol === undefined || ["openai-chat", "openai-responses", "anthropic"].includes(node.protocol), "调用协议无效");
      check("messages", node.messages === undefined || Array.isArray(node.messages), "消息无效");
      check("prompt", node.prompt === undefined || typeof node.prompt === "string", "提示词无效");
      check("system", node.system === undefined || typeof node.system === "string", "系统提示词无效");
      check("maxTokens", node.maxTokens === undefined || (Number.isSafeInteger(node.maxTokens) && node.maxTokens > 0), "输出预算无效");
      check("promptMode", ["append", "replace"].includes(node.promptMode), "提示词方式无效");
      return;
    case "jev":
      check("model", typeof node.model === "string" && !!node.model.trim(), "请选择 Jev 模型");
      check("channelId", node.channelId === undefined || (typeof node.channelId === "string" && !!node.channelId.trim()), "个人渠道无效");
      check("state", typeof node.state === "string" || (node.state !== null && typeof node.state === "object"), "Jev 状态无效");
      check("questions", record(node.questions) && Object.keys(node.questions).length > 0, "Jev 问题无效");
      check("assets", node.assets === undefined || record(node.assets), "Jev 附件无效");
      check("answerKey", node.answerKey === undefined || (typeof node.answerKey === "string" && !!node.answerKey.trim()), "答案 ID 无效");
      if (!bound.has("answerKey") && !bound.has("questions") &&
        node.answerKey && record(node.questions) && !Object.hasOwn(node.questions, node.answerKey))
        bad("答案 ID 不在问题中");
      return;
  }
}
