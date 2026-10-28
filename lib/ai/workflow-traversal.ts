import { HostError } from "@pluhub/sdk";
import type { AIRequest, Protocol } from "@pluhub/contracts/ai";
import type {
  ChannelWorkflow,
  WorkflowNode,
  WorkflowResult,
} from "@pluhub/contracts/workflow";
import { requireIngressProtocol } from "./workflow-protocol.js";

export type WorkflowPathResult = WorkflowResult & { responseText?: string };
type Step =
  | { nodeId: string }
  | { limit: NonNullable<WorkflowResult["requestLimits"]>[number] };

/** One set of execution rules for previews, ordinary routes and paid workflows. */
export function* traverseWorkflow(
  profile: string,
  flow: ChannelWorkflow,
  request: AIRequest,
  signal: AbortSignal,
  context: { ingressProtocol?: Protocol } = {},
): Generator<Step, WorkflowPathResult, WorkflowNode | undefined> {
  if (
    flow.nodes.some((node) => node.type === "response") &&
    (request.operation ||
      request.tools.length ||
      request.webSearch ||
      (request.responseFormat && request.responseFormat.type !== "text") ||
      request.messages.some(
        (message) =>
          message.role === "tool" ||
          message.calls?.length ||
          message.content?.some((part) => part.type !== "text"),
      ))
  )
    throw new HostError(
      "unsupported_feature",
      "文本响应流程不支持工具、图片或结构化输出",
      400,
    );
  const trace = { profile, nodes: [] as string[] };
  const requestLimits: NonNullable<WorkflowResult["requestLimits"]> = [];
  const outputPolicies: NonNullable<WorkflowResult["outputPolicies"]> = [];
  let outputPolicy: WorkflowResult["outputPolicy"];
  let protocolPolicy: WorkflowResult["protocolPolicy"];
  let id = flow.entry;
  const seen = new Set<string>();
  for (let steps = 0; steps < 128; steps++) {
    signal.throwIfAborted();
    if (!id || seen.has(id))
      throw new HostError("invalid_workflow", "请求路径缺失或形成循环", 400);
    seen.add(id);
    const node = (yield { nodeId: id })!;
    trace.nodes.push(id);
    const common = {
      request,
      target: "",
      mode: "implicit" as const,
      trace,
      requestLimits,
      outputPolicy,
      outputPolicies,
      protocolPolicy,
    };
    if (
      request.operation &&
      [
        "prompt",
        "reasoning",
        "maxTokens",
        "tps",
        "routing",
        "response",
      ].includes(node.type)
    )
      throw new HostError(
        "operation_not_supported",
        "此流程节点仅支持对话请求",
        400,
      );
    if (node.type === "response") return { ...common, responseText: node.text };
    if (node.type === "platform")
      return {
        ...common,
        platformGroup: { groupId: node.groupId, model: node.model },
      };
    if (node.type === "provider") {
      const fallback = node.fallback
        ? yield { nodeId: node.fallback }
        : undefined;
      if (fallback && fallback.type !== "platform")
        throw new HostError(
          "invalid_workflow",
          "备用出口需要连接平台分组节点",
          400,
        );
      return {
        ...common,
        provider: true,
        providerId: node.id,
        providerNode: node,
        ...(fallback?.type === "platform"
          ? { fallback: { groupId: fallback.groupId, model: fallback.model } }
          : {}),
      };
    }
    if (node.type === "routing")
      return { ...common, routingProfile: node.profile };
    if (node.type === "upstream")
      return { ...common, target: node.target, mode: node.mode };
    if (node.type === "branch") {
      id = node.condition ? node.yes : node.no;
      continue;
    }
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
    if (node.type === "rateLimit") {
      const policy = { channel: profile, node: node.id, rule: node.rule };
      yield { limit: policy };
      requestLimits.push(policy);
    }
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
    if (!("next" in node))
      throw new HostError(
        "invalid_workflow",
        "数据节点不能连接到请求路径",
        400,
      );
    id = node.next;
  }
  throw new HostError("invalid_workflow", "流程超过执行节点限制", 400);
}
