import { HostError } from "@pluhub/sdk";
import { modelPatternMatches } from "./model-pattern.js";
import { isDecisionProtocol } from "./decision-route-kind.js";
import { validateInterfaces } from "./upstream-interfaces.js";
import { resolveWorkflowBindings } from "./workflow-bindings.js";
import { migrateWorkflowConditions } from "@pluhub/contracts/workflow-migration";
import { validateWorkflowDataNode } from "./workflow-node-validation.js";
export { resolveWorkflowStatic } from "./workflow-bindings.js";
import type { AIRequest, Protocol } from "@pluhub/contracts/ai";
import type {
  ChannelWorkflow,
  WorkflowNode,
  WorkflowResult,
} from "@pluhub/contracts/workflow";

export class WorkflowValidationError extends HostError {
  constructor(
    public reason: string,
    public nodeIds: string[] = [],
  ) {
    super(
      "invalid_workflow",
      reason + (nodeIds.length ? "：" + nodeIds.join("、") : ""),
    );
  }
}
const bad = (message: string, nodeIds: string[] = []): never => {
  throw new WorkflowValidationError(message, nodeIds);
};
export const ingressProtocols: readonly Protocol[] = [
  "openai-chat",
  "openai-responses",
  "anthropic",
  "gemini",
];
export function requireIngressProtocol(value: unknown): Protocol {
  if (!ingressProtocols.includes(value as Protocol))
    throw new HostError(
      "ingress_protocol_required",
      "缺少有效的请求入口协议",
      400,
    );
  return value as Protocol;
}
export function checkProtocolConversion(
  ingress: Protocol | undefined,
  provider: string | undefined,
  policy?: WorkflowResult["protocolPolicy"],
) {
  if (policy?.conversion !== "disabled") return;
  const wireProtocol =
    provider === "codex" || provider === "grok"
      ? "openai-responses"
      : provider === "claude-subscription"
        ? "anthropic"
        : provider === "antigravity"
          ? "gemini"
          : provider;
  if (requireIngressProtocol(ingress) !== wireProtocol)
    throw new HostError(
      "protocol_conversion_forbidden",
      "此渠道仅接受与上游相同的协议，请调整入口或渠道协议策略",
      400,
    );
}
export function compileWorkflow(
  flow: ChannelWorkflow,
  personalInterfaces?: import("@pluhub/contracts/ai").UpstreamInterface[],
  personal = false,
) {
  if (
    !Array.isArray(flow.nodes) ||
    !flow.nodes.length ||
    flow.nodes.length > 128
  )
    bad("流程需要 1–128 个节点");
  flow = migrateWorkflowConditions(flow);
  if (flow.nodes.length > 128) bad("流程需要 1–128 个节点");
  flow = resolveWorkflowBindings(
    flow,
    { personalInterfaces, personal },
    undefined,
    bad,
  );
  const nodes = new Map<string, WorkflowNode>();
  for (const raw of flow.nodes) {
    const node = structuredClone(raw);
    validateWorkflowDataNode(node, new Set((flow.bindings ?? [])
      .filter((binding) => binding.target === node.id)
      .map((binding) => binding.input)));
    if (
      node.type === "platform" &&
      (!node.groupId || (node.model !== undefined && !node.model.trim()))
    )
      bad("平台分组节点需要选择分组和有效模型", [node.id]);
    if (node.type === "rateLimit") {
      const keys = ["rpm", "tpm", "concurrency", "bytesPerSecond"];
      if (
        !node.rule ||
        typeof node.rule !== "object" ||
        !Object.keys(node.rule).length ||
        Object.entries(node.rule).some(
          ([key, value]) =>
            !keys.includes(key) ||
            !Number.isSafeInteger(value) ||
            value! < 1 ||
            value! > 1_000_000_000,
        )
      )
        bad("请求限流需要至少一项有效的限制", [node.id]);
    }
    if (
      node.type === "tps" &&
      ((!node.rate && !node.aggregateRate) ||
        [node.rate, node.aggregateRate].some(
          (v) =>
            v !== undefined && (!Number.isFinite(v) || v <= 0 || v > 1_000_000),
        ) ||
        typeof node.tokenizer !== "string" ||
        !/^[A-Za-z0-9_.-]{1,128}$/.test(node.tokenizer) ||
        (node.model !== undefined &&
          (typeof node.model !== "string" ||
            !node.model.length ||
            node.model.length > 256)) ||
        (node.inheritDefault !== undefined &&
          typeof node.inheritDefault !== "boolean"))
    )
      bad("无效的 TPS 设置", [node.id]);
    if (
      node.type === "protocol" &&
      (!Array.isArray(node.allow) ||
        !node.allow.length ||
        node.allow.length > 4 ||
        new Set(node.allow).size !== node.allow.length ||
        node.allow.some((p) => !ingressProtocols.includes(p)) ||
        !["auto", "disabled"].includes(node.conversion))
    )
      bad("协议准入需要有效且不重复的入口协议及转换策略", [node.id]);
    if (
      (node.type === "condition" || node.type === "predicate") &&
      node.test === "protocol" &&
      !ingressProtocols.includes(node.protocol as Protocol)
    )
      bad("协议分支需要指定有效的入口协议", [node.id]);
    if (
      (node.type === "condition" || node.type === "predicate") &&
      !["hasTools", "stream", "textLengthAbove", "protocol", "model"].includes(
        node.test,
      )
    )
      bad("无效的分支条件", [node.id]);
    if (
      (node.type === "condition" || node.type === "predicate") &&
      node.value !== undefined &&
      (!Number.isSafeInteger(node.value) ||
        node.value < 0 ||
        node.value > 10_000_000)
    )
      bad("字符数阈值无效", [node.id]);
    if (
      (node.type === "condition" || node.type === "predicate") &&
      node.modelSource !== undefined &&
      !["requested", "mapped"].includes(node.modelSource)
    )
      bad("无效的模型比较对象", [node.id]);
    if (
      (node.type === "condition" || node.type === "predicate") &&
      node.protocol !== undefined &&
      !ingressProtocols.includes(node.protocol)
    )
      bad("协议分支需要指定有效的入口协议", [node.id]);
    if (
      node.type === "reasoning" &&
      !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
        node.effort,
      )
    )
      bad("无效的思考强度", [node.id]);
    if (
      node.type === "prompt" &&
      (typeof node.text !== "string" ||
        !node.text.length ||
        node.text.length > 16384)
    )
      bad("请输入有效的系统提示词", [node.id]);
    if (
      node.type === "maxTokens" &&
      (!Number.isSafeInteger(node.limit) ||
        node.limit < 1 ||
        node.limit > 1_000_000)
    )
      bad("无效的输出预算", [node.id]);
    if (
      node.type === "upstream" &&
      (((typeof node.target !== "string" ||
        !node.target.trim() ||
        node.target.length > 256) &&
        !(flow.bindings ?? []).some((binding) => binding.target === node.id && binding.input === "target")) ||
        !["implicit", "explicit"].includes(node.mode))
    )
      bad("请选择有效的目标模型和重定向方式", [node.id]);
    if (node.type === "upstream" && node.allowedTargets !== undefined &&
      (!Array.isArray(node.allowedTargets) || !node.allowedTargets.length ||
        node.allowedTargets.some((target) => typeof target !== "string" || !target.trim())))
      bad("允许的目标模型无效", [node.id]);
    if (
      node.type === "routing" &&
      (typeof node.profile !== "string" ||
        !node.profile.trim() ||
        node.profile.length > 128)
    )
      bad("请选择有效的路由策略", [node.id]);
    if (node.type === "provider") {
      if (node.recordResponseModel !== undefined && typeof node.recordResponseModel !== "boolean")
        bad("上游响应模型记录设置无效", [node.id]);
      if (
        node.model !== undefined &&
        (typeof node.model !== "string" ||
          !node.model.trim() ||
          node.model.length > 256)
      )
        bad("上游模型 ID 无效", [node.id]);
      const upstream = node.upstream;
      if (upstream) {
        if (
          ![
            "openai-chat",
            "openai-responses",
            "anthropic",
            "gemini",
            "codex",
            "claude-subscription",
            "antigravity",
            "grok",
            "systemone",
            "luna",
            "jev",
          ].includes(upstream.protocol)
        )
          bad("无效的上游协议", [node.id]);
        if (
          [upstream.accountId, upstream.projectId].some(
            (value) =>
              value !== undefined &&
              (typeof value !== "string" || value.length > 512),
          )
        )
          bad("无效的上游账号或项目", [node.id]);
        if (
          upstream.authMode !== undefined &&
          !["siwc", "cli"].includes(upstream.authMode)
        )
          bad("无效的订阅接入方式", [node.id]);
        if (
          upstream.subscriptionAccountIds &&
          (!upstream.subscriptionAccountIds.length ||
            upstream.subscriptionAccountIds.length > 100 ||
            new Set(upstream.subscriptionAccountIds).size !==
              upstream.subscriptionAccountIds.length ||
            upstream.subscriptionAccountIds.some(
              (id) => !id || id.length > 256,
            ))
        )
          bad("无效的订阅账号", [node.id]);
        if (isDecisionProtocol(upstream.protocol) && upstream.interfaces !== undefined)
          bad("决策服务不支持接口组合", [node.id]);
        if (upstream.interfaces !== undefined)
          validateInterfaces(upstream.interfaces);
      }
      if (node.interfaces !== undefined) validateInterfaces(node.interfaces);
    }
    if (!node.id || nodes.has(node.id))
      bad("节点标识不能为空或重复", [node.id]);
    if (
      (node.type === "condition" || node.type === "predicate") &&
      node.test === "model" &&
      (!Array.isArray(node.models) ||
        !node.models.length ||
        node.models.some(
          (model) => typeof model !== "string" || !model.trim(),
        ) ||
        (node.modelSource !== undefined &&
          !["requested", "mapped"].includes(node.modelSource)))
    )
      bad("模型条件需要填写模型 ID 或匹配规则", [node.id]);
    if (node.type === "branch") {
      if (typeof node.condition !== "boolean")
        bad("分支需要布尔条件", [node.id]);
      if (!flow.bindings?.some((binding) => binding.target === node.id && binding.input === "condition"))
        bad("分支需要连接布尔条件", [node.id]);
    }
    if (node.type === "compare") {
      const validType = ["string", "number", "boolean"].includes(node.valueType);
      const validOperator = node.operator === "eq" || node.operator === "ne" ||
        (node.valueType === "number" && ["gt", "gte", "lt", "lte"].includes(node.operator)) ||
        (node.valueType === "string" && node.operator === "matches");
      const validOperand = (value: unknown) => typeof value === node.valueType &&
        (node.valueType !== "number" || Number.isFinite(value));
      const validRight = node.operator === "matches"
        ? Array.isArray(node.right) && node.right.every((item) => typeof item === "string")
        : validOperand(node.right);
      if (!validType || !validOperator || !validOperand(node.left) || !validRight)
        bad("无效的比较条件", [node.id]);
    }
    if (node.type === "logic" &&
      (!["and", "or", "not"].includes(node.operator) || typeof node.left !== "boolean" ||
        (node.operator !== "not" && typeof node.right !== "boolean")))
      bad("无效的逻辑条件", [node.id]);
    nodes.set(node.id, Object.freeze(node));
  }
  if (nodes.get(flow.entry)?.type !== "start")
    bad("请选择有效的请求入口节点", [flow.entry]);
  const visiting = new Set<string>(),
    done = new Set<string>();
  function visit(id: string, source?: string) {
    if (visiting.has(id)) bad("节点形成循环，请调整连线", [...visiting, id]);
    if (done.has(id)) return;
    if (!id) bad("节点出口尚未连接", source ? [source] : []);
    const node = nodes.get(id);
    if (!node) bad("连线指向不存在的节点", source ? [source, id] : [id]);
    if (["value", "predicate", "compare", "logic", "text", "format", "template", "replace", "llm", "jev"].includes(node!.type))
      bad("数据节点不能连接到请求路径", [id]);
    visiting.add(id);
    if (node!.type === "provider" && node!.fallback) {
      if (nodes.get(node!.fallback)?.type !== "platform")
        bad("备用出口需要连接平台分组节点", [id]);
      visit(node!.fallback, id);
    }
    if (
      node!.type !== "upstream" &&
      node!.type !== "provider" &&
      node!.type !== "routing" &&
      node!.type !== "platform" &&
      node!.type !== "response"
    ) {
      if (node!.type === "condition" || node!.type === "branch") {
        visit(node!.yes, id);
        visit(node!.no, id);
      } else if ("next" in node!) visit(node.next, id);
      else bad("数据节点不能连接到请求路径", [id]);
    }
    visiting.delete(id);
    done.add(id);
  }
  visit(flow.entry);
  if (
    [...nodes.values()].some(
      (node) => !["value", "predicate", "compare", "logic", "text", "format", "template", "replace", "llm", "jev"].includes(node.type) && !done.has(node.id),
    )
  )
    bad(
      "以下节点未接入请求路径，请连接或删除",
      [...nodes.values()]
        .filter((node) => !["value", "predicate", "compare", "logic", "text", "format", "template", "replace", "llm", "jev"].includes(node.type) && !done.has(node.id))
        .map((node) => node.id),
    );
  return { entry: flow.entry, nodes };
}
export function runWorkflow(
  profile: string,
  flow: ChannelWorkflow,
  input: AIRequest,
  signal: AbortSignal,
  context: {
    ingressProtocol?: Protocol;
    requestedModel?: string;
    mappedModel?: string;
    personalInterfaces?: import("@pluhub/contracts/ai").UpstreamInterface[];
    personal?: boolean;
  } = {},
): WorkflowResult {
  flow = migrateWorkflowConditions(flow);
  const graph = compileWorkflow(
      flow,
      context.personalInterfaces,
      context.personal,
    ),
    request = structuredClone(input);
  const trace = { profile, nodes: [] as string[] };
  let id = graph.entry;
  let outputPolicy: WorkflowResult["outputPolicy"];
  const outputPolicies: NonNullable<WorkflowResult["outputPolicies"]> = [];
  const requestLimits: NonNullable<WorkflowResult["requestLimits"]> = [];
  let protocolPolicy: WorkflowResult["protocolPolicy"];
  for (let steps = 0; steps < 128; steps++) {
    signal.throwIfAborted();
    const effective = resolveWorkflowBindings(flow, context, request, bad, id);
    const node = compileWorkflow(effective, context.personalInterfaces, context.personal).nodes.get(id)!;
    if (node.type === "value" || node.type === "predicate" || node.type === "compare" || node.type === "logic" ||
        node.type === "text" || node.type === "format" || node.type === "template" || node.type === "replace" || node.type === "llm" || node.type === "jev")
      return bad("数据节点不能连接到请求路径", [id]);
    trace.nodes.push(id);
    if (
      request.operation &&
      ["prompt", "reasoning", "maxTokens", "tps", "routing"].includes(node.type)
    )
      throw new HostError(
        "operation_not_supported",
        "This channel node requires a conversational request",
        400,
      );
    if (node.type === "platform")
      return {
        request,
        target: "",
        platformGroup: { groupId: node.groupId, model: node.model },
        mode: "implicit",
        trace,
        outputPolicy,
        outputPolicies,
        requestLimits,
        protocolPolicy,
      };
    if (node.type === "provider")
      return {
        request,
        target: "",
        provider: true,
        providerId: node.id,
        providerNode: node,
        ...(node.fallback
          ? {
              fallback: (() => {
                const target = graph.nodes.get(node.fallback)!;
                return target.type === "platform"
                  ? { groupId: target.groupId, model: target.model }
                  : undefined;
              })(),
            }
          : {}),
        mode: "implicit",
        trace,
        outputPolicy,
        outputPolicies,
        requestLimits,
        protocolPolicy,
      };
    if (node.type === "routing")
      return {
        request,
        target: "",
        routingProfile: node.profile,
        mode: "implicit",
        trace,
        outputPolicy,
        outputPolicies,
        requestLimits,
        protocolPolicy,
      };
    if (node.type === "upstream")
      return {
        request,
        target: node.target,
        mode: node.mode,
        trace,
        outputPolicy,
        outputPolicies,
        requestLimits,
        protocolPolicy,
      };
    if (node.type === "condition") {
      const yes =
        node.test === "model"
          ? node.models!.some((rule) =>
              modelPatternMatches(
                rule,
                node.modelSource === "mapped"
                  ? (context.mappedModel ?? request.model)
                  : (context.requestedModel ?? request.model),
              ),
            )
          : node.test === "hasTools"
            ? request.tools.length > 0 || !!request.webSearch
            : node.test === "protocol"
              ? requireIngressProtocol(context.ingressProtocol) ===
                node.protocol
              : node.test === "stream"
                ? request.stream
                : request.messages.reduce((n, m) => n + m.text.length, 0) >
                  (node.value ?? 0);
      id = yes ? node.yes : node.no;
      continue;
    }
    if (node.type === "branch") {
      id = node.condition ? node.yes : node.no;
      continue;
    }
    if (node.type === "response") return bad("此响应节点需要异步执行", [id]);
    if (node.type === "protocol") {
      if (!node.allow.includes(requireIngressProtocol(context.ingressProtocol)))
        throw new HostError(
          "protocol_not_allowed",
          "此渠道未允许当前请求协议",
          400,
        );
      protocolPolicy = {
        conversion:
          protocolPolicy?.conversion === "disabled"
            ? "disabled"
            : node.conversion,
      };
    }
    if (node.type === "prompt")
      request.messages.unshift({ role: "system", text: node.text });
    if (node.type === "reasoning") request.reasoning = { effort: node.effort };
    if (node.type === "maxTokens")
      request.maxTokens = Math.min(request.maxTokens ?? node.limit, node.limit);
    if (node.type === "rateLimit")
      requestLimits.push({ channel: profile, node: node.id, rule: node.rule });
    if (node.type === "tps") {
      outputPolicies.push({
        ...(node.model ? { model: node.model } : {}),
        ...(node.rate ? { tps: node.rate } : {}),
        ...(node.aggregateRate ? { aggregateTps: node.aggregateRate } : {}),
        tokenizer: node.tokenizer,
        inheritDefault: node.inheritDefault,
      });
      if (!node.model)
        outputPolicy = {
          ...outputPolicies.at(-1)!,
          ...(node.rate
            ? { tps: Math.min(outputPolicy?.tps ?? Infinity, node.rate) }
            : {}),
        };
    }
    id = node.next;
  }
  return bad("Workflow exceeds its execution limit");
}
