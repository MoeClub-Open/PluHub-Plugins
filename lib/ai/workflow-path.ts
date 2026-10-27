import { HostError } from "@pluhub/sdk";
import type { AIRequest, Protocol } from "@pluhub/contracts/ai";
import type { ChannelWorkflow, WorkflowNode, WorkflowResult } from "@pluhub/contracts/workflow";
import { modelPatternMatches } from "./model-pattern.js";
import { requireIngressProtocol } from "./channel-graph.js";

type DataGraph = { resolveNode(id: string): Promise<WorkflowNode> };
export type WorkflowPathResult = WorkflowResult & { responseText?: string };

/** Traverse only the selected execution path, resolving its data inputs on demand. */
export async function runWorkflowPath(
  profile: string,
  flow: ChannelWorkflow,
  request: AIRequest,
  graph: DataGraph,
  signal: AbortSignal,
  context: { ingressProtocol?: Protocol; requestedModel?: string; mappedModel?: string } = {},
  onLimit?: (policy: NonNullable<WorkflowResult["requestLimits"]>[number]) => Promise<void>,
): Promise<WorkflowPathResult> {
  // Validate known response-format limitations before starting paid dependencies.
  if (flow.nodes.some((node) => node.type === "response") &&
      (request.operation || request.tools.length || request.webSearch ||
       (request.responseFormat && request.responseFormat.type !== "text") ||
       request.messages.some((message) => message.role === "tool" || message.calls?.length || message.content?.some((part) => part.type !== "text"))))
    throw new HostError("unsupported_feature", "文本响应流程不支持工具、图片或结构化输出", 400);
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
    const node = await graph.resolveNode(id);
    trace.nodes.push(id);
    const common = {
      request, target: "", mode: "implicit" as const, trace,
      requestLimits, outputPolicy, outputPolicies, protocolPolicy,
    };
    if (request.operation && ["prompt", "reasoning", "maxTokens", "tps", "routing", "response"].includes(node.type))
      throw new HostError("operation_not_supported", "此流程节点仅支持对话请求", 400);
    if (node.type === "response") {
      if (typeof node.text !== "string")
        throw new HostError("invalid_workflow", "响应节点需要文本", 400);
      if (request.tools.length || request.webSearch ||
          (request.responseFormat && request.responseFormat.type !== "text") ||
          request.messages.some((message) => message.role === "tool" || message.calls?.length || message.content?.some((part) => part.type !== "text")))
        throw new HostError("unsupported_feature", "文本响应流程不支持工具、图片或结构化输出", 400);
      return { ...common, responseText: node.text };
    }
    if (node.type === "platform")
      return { ...common, platformGroup: { groupId: node.groupId, model: node.model } };
    if (node.type === "provider") {
      const fallbackNode = node.fallback ? await graph.resolveNode(node.fallback) : undefined;
      if (fallbackNode && fallbackNode.type !== "platform")
        throw new HostError("invalid_workflow", "备用出口需要连接平台分组节点", 400);
      return {
        ...common, provider: true, providerId: node.id, providerNode: node,
        ...(fallbackNode?.type === "platform" ? { fallback: { groupId: fallbackNode.groupId, model: fallbackNode.model } } : {}),
      };
    }
    if (node.type === "routing") return { ...common, routingProfile: node.profile };
    if (node.type === "upstream") return { ...common, target: node.target, mode: node.mode };
    if (node.type === "branch") {
      if (typeof node.condition !== "boolean")
        throw new HostError("invalid_workflow", "分支条件必须是布尔值", 400);
      id = node.condition ? node.yes : node.no;
      continue;
    }
    // Old graphs may still be loaded before their condition migration is saved.
    if (node.type === "condition") {
      const yes = node.test === "model"
        ? node.models!.some((rule) => modelPatternMatches(rule, node.modelSource === "mapped" ? (context.mappedModel ?? request.model) : (context.requestedModel ?? request.model)))
        : node.test === "hasTools" ? request.tools.length > 0 || !!request.webSearch
        : node.test === "protocol" ? requireIngressProtocol(context.ingressProtocol) === node.protocol
        : node.test === "stream" ? request.stream
        : request.messages.reduce((n, message) => n + message.text.length, 0) > (node.value ?? 0);
      id = yes ? node.yes : node.no;
      continue;
    }
    if (node.type === "protocol") {
      if (!node.allow.includes(requireIngressProtocol(context.ingressProtocol)))
        throw new HostError("protocol_not_allowed", "此渠道未允许当前请求协议", 400);
      protocolPolicy = { conversion: protocolPolicy?.conversion === "disabled" ? "disabled" : node.conversion };
    }
    if (node.type === "prompt") request.messages.unshift({ role: "system", text: node.text });
    if (node.type === "reasoning") request.reasoning = { effort: node.effort };
    if (node.type === "maxTokens") request.maxTokens = Math.min(request.maxTokens ?? node.limit, node.limit);
    if (node.type === "rateLimit") {
      const policy = { channel: profile, node: node.id, rule: node.rule };
      await onLimit?.(policy);
      requestLimits.push(policy);
    }
    if (node.type === "tps") {
      outputPolicies.push({
        ...(node.model ? { model: node.model } : {}),
        ...(node.rate ? { tps: node.rate } : {}),
        ...(node.aggregateRate ? { aggregateTps: node.aggregateRate } : {}),
        tokenizer: node.tokenizer, inheritDefault: node.inheritDefault,
      });
      if (!node.model) outputPolicy = {
        ...outputPolicies.at(-1)!,
        ...(node.rate ? { tps: Math.min(outputPolicy?.tps ?? Infinity, node.rate) } : {}),
      };
    }
    if (!("next" in node))
      throw new HostError("invalid_workflow", "数据节点不能连接到请求路径", 400);
    id = node.next;
  }
  throw new HostError("invalid_workflow", "流程超过执行节点限制", 400);
}
