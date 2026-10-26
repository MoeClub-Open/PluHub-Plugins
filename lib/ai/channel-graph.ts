import { HostError } from "@pluhub/sdk";
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
export function compileWorkflow(flow: ChannelWorkflow) {
  if (
    !Array.isArray(flow.nodes) ||
    !flow.nodes.length ||
    flow.nodes.length > 64
  )
    bad("流程需要 1–64 个节点");
  const nodes = new Map<string, WorkflowNode>();
  for (const raw of flow.nodes) {
    const node = structuredClone(raw);
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
      node.type === "condition" &&
      node.test === "protocol" &&
      !ingressProtocols.includes(node.protocol as Protocol)
    )
      bad("协议分支需要指定有效的入口协议", [node.id]);
    if (!node.id || nodes.has(node.id))
      bad("节点标识不能为空或重复", [node.id]);
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
    if (!node) bad("连线指向不存在的节点", source ? [source] : [id]);
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
      node!.type !== "platform"
    ) {
      if (node!.type === "condition") {
        visit(node!.yes, id);
        visit(node!.no, id);
      } else visit(node!.next, id);
    }
    visiting.delete(id);
    done.add(id);
  }
  visit(flow.entry);
  if (done.size !== nodes.size)
    bad(
      "以下节点未接入请求路径，请连接或删除",
      [...nodes.keys()].filter((id) => !done.has(id)),
    );
  return { entry: flow.entry, nodes };
}
export function runWorkflow(
  profile: string,
  flow: ChannelWorkflow,
  input: AIRequest,
  signal: AbortSignal,
  context: { ingressProtocol?: Protocol } = {},
): WorkflowResult {
  const graph = compileWorkflow(flow),
    request = structuredClone(input);
  const trace = { profile, nodes: [] as string[] };
  let id = graph.entry;
  let outputPolicy: WorkflowResult["outputPolicy"];
  const outputPolicies: NonNullable<WorkflowResult["outputPolicies"]> = [];
  const requestLimits: NonNullable<WorkflowResult["requestLimits"]> = [];
  let protocolPolicy: WorkflowResult["protocolPolicy"];
  for (let steps = 0; steps < 64; steps++) {
    signal.throwIfAborted();
    const node = graph.nodes.get(id)!;
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
        node.test === "hasTools"
          ? request.tools.length > 0 || !!request.webSearch
          : node.test === "protocol"
            ? requireIngressProtocol(context.ingressProtocol) === node.protocol
            : node.test === "stream"
              ? request.stream
              : request.messages.reduce((n, m) => n + m.text.length, 0) >
                (node.value ?? 0);
      id = yes ? node.yes : node.no;
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
