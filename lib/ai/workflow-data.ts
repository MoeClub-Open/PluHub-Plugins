import { HostError } from "@pluhub/sdk";
import type {
  AIRequest,
  Protocol,
  UpstreamInterface,
  Usage,
} from "@pluhub/contracts/ai";
import type { WorkflowBinding, WorkflowNode } from "@pluhub/contracts/workflow";
import {
  evaluateCompare,
  evaluateLogic,
  evaluatePredicate,
} from "./workflow-condition.js";
import { validateWorkflowDataNode } from "./workflow-node-validation.js";
import { validValue } from "./workflow-bindings.js";
import {
  compatibleWorkflowTypes,
  workflowDataOutputs,
  workflowParameters,
} from "./workflow-parameters.js";

type Node = { id: string; type: string };
type Context = {
  ingressProtocol?: Protocol;
  requestedModel?: string;
  mappedModel?: string;
  personalInterfaces?: UpstreamInterface[];
  personal?: boolean;
};
export type WorkflowLLMResult = { text: string; usage?: Usage };
export type WorkflowJevResult = {
  answers: Record<string, unknown>;
  choice?: string;
  confidence?: number;
  score?: number;
  noul?: number;
  box?: Record<string, unknown>;
};

/** Values are evaluated only when a reached execution node needs them. */
export function createWorkflowDataGraph<N extends Node>(options: {
  flow: { nodes: N[]; bindings?: WorkflowBinding[] };
  request: AIRequest;
  context?: Context;
  signal: AbortSignal;
  callLLM: (
    node: N,
    request: AIRequest,
    signal: AbortSignal,
  ) => Promise<WorkflowLLMResult>;
  callJev: (
    node: N,
    request: AIRequest,
    signal: AbortSignal,
  ) => Promise<WorkflowJevResult>;
}) {
  const { flow, request, signal } = options;
  const nodes = new Map(flow.nodes.map((node) => [node.id, node]));
  const bindings = new Map<string, WorkflowBinding[]>();
  for (const binding of flow.bindings ?? []) {
    if (!nodes.has(binding.source) || !nodes.has(binding.target))
      throw new HostError("invalid_workflow", "参数连线指向不存在的节点", 400);
    const from = workflowDataOutputs(
      nodes.get(binding.source)! as unknown as WorkflowNode,
    ).find((item) => item.path === binding.output);
    const to = workflowParameters(
      nodes.get(binding.target)! as unknown as WorkflowNode,
      options.context?.personalInterfaces,
      options.context?.personal,
    ).find((item) => item.path === binding.input);
    if (!from || !to || !compatibleWorkflowTypes(from.type, to.type))
      throw new HostError("invalid_workflow", "参数连线类型不匹配", 400);
    const paths = binding.input.split(".");
    if (
      paths.some(
        (part) =>
          !part || ["__proto__", "prototype", "constructor"].includes(part),
      )
    )
      throw new HostError("invalid_workflow", "无效的参数路径", 400);
    const incoming = bindings.get(binding.target) ?? [];
    if (incoming.some((item) => item.input === binding.input))
      throw new HostError("invalid_workflow", "参数只能连接一个数据来源", 400);
    incoming.push(binding);
    bindings.set(binding.target, incoming);
  }
  for (const node of flow.nodes) {
    if (node.type === "template")
      validateWorkflowDataNode(
        node as unknown as WorkflowNode,
        new Set((bindings.get(node.id) ?? []).map((item) => item.input)),
      );
  }

  // Detect cycles before any asynchronous computation can wait on itself.
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function check(id: string) {
    if (visiting.has(id))
      throw new HostError("invalid_workflow", "参数连线形成循环", 400);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const binding of bindings.get(id) ?? []) check(binding.source);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of nodes.keys()) check(id);

  const dynamic = new Map<string, boolean>();
  function dynamicSource(id: string): boolean {
    if (dynamic.has(id)) return dynamic.get(id)!;
    const node = sourceNode(id);
    const result =
      ["start", "predicate", "llm", "jev"].includes(node.type) ||
      (bindings.get(id) ?? []).some((item) => dynamicSource(item.source));
    dynamic.set(id, result);
    return result;
  }
  for (const [targetId, incoming] of bindings) {
    const node = sourceNode(targetId) as unknown as WorkflowNode;
    const fields = workflowParameters(
      node,
      options.context?.personalInterfaces,
      options.context?.personal,
    );
    for (const binding of incoming) {
      const field = fields.find((item) => item.path === binding.input)!;
      const delegatedTarget =
        (node.type === "llm" && binding.input === "model") ||
        (node.type === "upstream" && binding.input === "target");
      if (field.sensitive && dynamicSource(binding.source) && !delegatedTarget)
        throw new HostError(
          "invalid_workflow",
          "此参数只允许受控的静态输入",
          400,
        );
    }
  }

  const evaluated = new Map<string, Promise<Record<string, unknown>>>();
  const resolved = new Map<string, Promise<N>>();

  function sourceNode(id: string): N {
    const node = nodes.get(id);
    if (!node) throw new HostError("invalid_workflow", "参数节点不存在", 400);
    return node;
  }

  function write(target: Record<string, any>, path: string, value: unknown) {
    const parts = path.split(".");
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i]!;
      if (!Object.hasOwn(target, key) || target[key] == null)
        target[key] = /^\d+$/.test(parts[i + 1]!) ? [] : {};
      if (typeof target[key] !== "object")
        throw new HostError("invalid_workflow", "无效的参数路径", 400);
      target = target[key];
    }
    target[parts.at(-1)!] = structuredClone(value);
  }

  // Wait for every started dependency, even when one fails, so each request
  // finishes its own accounting and cleanup before the parent returns.
  async function settle<T>(promises: Promise<T>[]): Promise<T[]> {
    const results = await Promise.allSettled(promises);
    const failed = results.find((item) => item.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    return results.map((item) => (item as PromiseFulfilledResult<T>).value);
  }

  async function get(id: string, output: string): Promise<unknown> {
    signal.throwIfAborted();
    const field = workflowDataOutputs(
      sourceNode(id) as unknown as WorkflowNode,
    ).find((item) => item.path === output);
    if (!field) throw new HostError("invalid_workflow", "数据输出不存在", 400);
    let promise = evaluated.get(id);
    if (!promise) {
      promise = evaluate(id);
      evaluated.set(id, promise);
    }
    const values = await promise;
    if (
      !Object.hasOwn(values, output) ||
      !validValue(field.type, values[output])
    )
      throw new HostError("invalid_workflow", "参数来源没有有效值", 400);
    return values[output];
  }

  async function input(id: string, field: string): Promise<unknown> {
    const binding = (bindings.get(id) ?? []).find(
      (item) => item.input === field,
    );
    if (binding) return get(binding.source, binding.output);
    return field
      .split(".")
      .reduce<any>(
        (value, part) =>
          value != null && Object.hasOwn(value, part) ? value[part] : undefined,
        sourceNode(id),
      );
  }

  function resolveNode(id: string): Promise<N> {
    let promise = resolved.get(id);
    if (!promise) {
      promise = (async () => {
        signal.throwIfAborted();
        const result = structuredClone(sourceNode(id));
        const incoming = bindings.get(id) ?? [];
        const values = await settle(
          incoming.map((item) => get(item.source, item.output)),
        );
        const fields = workflowParameters(
          result as unknown as WorkflowNode,
          options.context?.personalInterfaces,
          options.context?.personal,
        );
        incoming.forEach((item, i) => {
          const field = fields.find((entry) => entry.path === item.input);
          if (!field || !validValue(field.type, values[i]))
            throw new HostError("invalid_workflow", "参数来源类型不匹配", 400);
          write(result as Record<string, any>, item.input, values[i]);
        });
        const data = result as Record<string, any>;
        const target =
          data.type === "llm"
            ? "model"
            : data.type === "upstream"
              ? "target"
              : undefined;
        const allowed =
          data.type === "llm" ? data.allowedModels : data.allowedTargets;
        const binding = incoming.find((item) => item.input === target);
        if (
          data.type === "upstream" &&
          (typeof data.target !== "string" ||
            !data.target.trim() ||
            data.target.length > 256)
        )
          throw new HostError("invalid_workflow", "请选择有效的目标模型", 400);
        if (
          binding &&
          dynamicSource(binding.source) &&
          (!Array.isArray(allowed) || !allowed.includes(data[target!]))
        )
          throw new HostError(
            "invalid_workflow",
            "动态目标不在允许列表中",
            400,
          );
        validateWorkflowDataNode(result as unknown as WorkflowNode);
        return result;
      })();
      resolved.set(id, promise);
    }
    return promise;
  }

  async function evaluate(id: string): Promise<Record<string, unknown>> {
    const source = sourceNode(id);
    if (source.type === "start") {
      const user = [...request.messages]
        .reverse()
        .find((message) => message.role === "user");
      return {
        requestedModel: options.context?.requestedModel ?? request.model,
        mappedModel: options.context?.mappedModel ?? request.model,
        ingressProtocol: options.context?.ingressProtocol,
        stream: request.stream,
        hasTools: request.tools.length > 0 || !!request.webSearch,
        textLength: request.messages.reduce(
          (sum, message) => sum + message.text.length,
          0,
        ),
        text: user?.text ?? "",
        messages: structuredClone(request.messages),
      };
    }
    if (source.type === "logic") {
      // Boolean short circuit avoids starting paid dependencies that are not needed.
      const left = await input(id, "left");
      if (typeof left !== "boolean")
        throw new HostError("invalid_workflow", "逻辑输入必须是布尔值", 400);
      const operator = (source as any).operator;
      if (operator === "not") return { result: !left };
      if ((operator === "and" && !left) || (operator === "or" && left))
        return { result: left };
      const right = await input(id, "right");
      if (typeof right !== "boolean")
        throw new HostError("invalid_workflow", "逻辑输入必须是布尔值", 400);
      return {
        result: evaluateLogic({ ...source, left, right } as unknown as Extract<
          WorkflowNode,
          { type: "logic" }
        >),
      };
    }
    const node = await resolveNode(id);
    const data = node as Record<string, any>;
    switch (node.type) {
      case "value":
        return {
          value: data.valueType === "secret" ? data.secretRef : data.value,
        };
      case "predicate":
        return {
          result: evaluatePredicate(
            node as unknown as Extract<WorkflowNode, { type: "predicate" }>,
            request,
            options.context,
          ),
        };
      case "compare":
        return {
          result: evaluateCompare(
            node as unknown as Extract<WorkflowNode, { type: "compare" }>,
          ),
        };
      case "text":
        return { text: data.text };
      case "format":
        return {
          text: typeof data.value === "string" ? data.value : JSON.stringify(data.value),
        };
      case "template": {
        const text = String(data.template).replace(
          /\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,63})\s*\}\}/g,
          (_match, name: string) => {
            const value = Object.hasOwn(data.values, name)
              ? data.values[name]
              : undefined;
            if (typeof value !== "string")
              throw new HostError(
                "invalid_workflow",
                `模板变量缺少文本值：${name}`,
                400,
              );
            return value;
          },
        );
        return { text };
      }
      case "replace": {
        const { text, find, replacement, all } = data;
        if (
          typeof text !== "string" ||
          typeof find !== "string" ||
          !find ||
          typeof replacement !== "string"
        )
          throw new HostError("invalid_workflow", "文本替换参数无效", 400);
        const index = text.indexOf(find);
        return {
          text: all
            ? text.split(find).join(replacement)
            : index < 0
              ? text
              : text.slice(0, index) +
                replacement +
                text.slice(index + find.length),
        };
      }
      case "llm":
        return options.callLLM(node, request, signal);
      case "jev":
        return options.callJev(node, request, signal);
      default:
        throw new HostError("invalid_workflow", "节点不能作为数据来源", 400);
    }
  }
  return { get, resolveNode };
}
