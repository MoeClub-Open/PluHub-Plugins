import { HostError } from "@pluhub/sdk";
import type {
  AIRequest,
  Protocol,
  UpstreamInterface,
} from "@pluhub/contracts/ai";
import type {
  ChannelWorkflow,
  WorkflowBinding,
  WorkflowNode,
  WorkflowValueType,
} from "@pluhub/contracts/workflow";
import {
  workflowDataOutputs,
  workflowParameters,
  compatibleWorkflowTypes,
} from "./workflow-parameters.js";
import { evaluateCompare, evaluateLogic, evaluatePredicate } from "./workflow-condition.js";
import { validateWorkflowDataNode } from "./workflow-node-validation.js";

type Context = {
  requestedModel?: string;
  mappedModel?: string;
  ingressProtocol?: Protocol;
  personalInterfaces?: UpstreamInterface[];
  personal?: boolean;
};
type Fail = (message: string, nodeIds?: string[]) => never;
const defaultFail: Fail = (message, nodes = []) => {
  throw new HostError(
    "invalid_workflow",
    message + (nodes.length ? "：" + nodes.join("、") : ""),
    400,
  );
};

export function validValue(type: WorkflowValueType, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isSafeInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "string[]":
      return (
        Array.isArray(value) && value.every((item) => typeof item === "string")
      );
    case "object":
      return !!value && typeof value === "object";
    case "json":
      return value === null || typeof value === "string" || typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value)) ||
        (typeof value === "object" && value !== null);
    case "secret":
      return (
        typeof value === "string" ||
        (Array.isArray(value) &&
          value.every((item) => typeof item === "string"))
      );
  }
}

function setPath(node: WorkflowNode, path: string, value: unknown, fail: Fail) {
  const parts = path.split(".");
  let target: any = node;
  for (const [index, key] of parts.slice(0, -1).entries()) {
    if (!Object.hasOwn(target, key))
      target[key] = /^\d+$/.test(parts[index + 1]!) ? [] : {};
    target = target[key];
    if (target === null || typeof target !== "object")
      fail("无效的参数路径", [node.id]);
  }
  target[parts.at(-1)!] = structuredClone(value);
}

/** Validate typed connections and evaluate either constant inputs or a full request. */
export function resolveWorkflowBindings(
  flow: ChannelWorkflow,
  context: Context = {},
  request?: AIRequest,
  fail: Fail = defaultFail,
  onlyTargetId?: string,
): ChannelWorkflow {
  if (flow.bindings !== undefined && !Array.isArray(flow.bindings))
    fail("无效的参数连线");
  const nodes = new Map(flow.nodes.map((node) => [node.id, node]));
  const targets = new Map<string, WorkflowBinding>();
  const incoming = new Map<string, WorkflowBinding[]>();
  const inputFields = new Map<string, ReturnType<typeof workflowParameters>>();
  const outputFields = new Map<
    string,
    ReturnType<typeof workflowDataOutputs>
  >();
  const personal = context.personal === true;
  const inputsFor = (id: string) => {
    if (!inputFields.has(id))
      inputFields.set(
        id,
        workflowParameters(
          nodes.get(id)!,
          context.personalInterfaces,
          personal,
        ),
      );
    return inputFields.get(id)!;
  };
  const outputsFor = (id: string) => {
    if (!outputFields.has(id))
      outputFields.set(id, workflowDataOutputs(nodes.get(id)!));
    return outputFields.get(id)!;
  };
  // Validate template variable names before deriving input paths or writing values.
  for (const node of flow.nodes)
    if (node.type === "template")
      validateWorkflowDataNode(node, new Set((flow.bindings ?? [])
        .filter((binding) => binding.target === node.id)
        .map((binding) => binding.input)));
  for (const node of flow.nodes) {
    if (node.type !== "value") continue;
    if (
      !workflowDataOutputs(node).length ||
      ![
        "string",
        "number",
        "integer",
        "boolean",
        "string[]",
        "object",
        "json",
        "secret",
      ].includes(node.valueType)
    )
      fail("无效的数据节点类型", [node.id]);
    if (node.valueType === "secret" && node.value !== undefined)
      fail("密钥节点只能使用密钥输入", [node.id]);
    if (node.valueType !== "secret" && node.secretRef !== undefined)
      fail("普通数据节点不能保存密钥", [node.id]);
  }
  for (const binding of flow.bindings ?? []) {
    if (typeof binding.input !== "string" || binding.input.split(".").some(
      (part) => !part || ["__proto__", "prototype", "constructor"].includes(part),
    )) fail("无效的参数路径", [binding.target]);
    const source = nodes.get(binding.source),
      target = nodes.get(binding.target);
    if (!source || !target)
      fail("参数连线指向不存在的节点", [binding.source, binding.target]);
    const output = outputsFor(binding.source).find(
      (field) => field.path === binding.output,
    );
    const input = inputsFor(binding.target).find(
      (field) => field.path === binding.input,
    );
    if (!output || !input || !compatibleWorkflowTypes(output.type, input.type))
      fail("参数连线类型不匹配", [binding.source, binding.target]);
    const key = binding.target + "\0" + binding.input;
    if (targets.has(key)) fail("参数只能连接一个数据来源", [binding.target]);
    targets.set(key, binding);
    if (!incoming.has(binding.target)) incoming.set(binding.target, []);
    incoming.get(binding.target)!.push(binding);
  }
  for (const node of flow.nodes) {
    if (node.type !== "value") continue;
    const path = node.valueType === "secret" ? "secretRef" : "value";
    const value = node.valueType === "secret" ? node.secretRef : node.value;
    if (
      !validValue(node.valueType, value) &&
      !targets.has(node.id + "\0" + path)
    )
      fail("数据节点的值与类型不匹配", [node.id]);
  }
  const visiting = new Set<string>(),
    tainted = new Map<string, boolean>();
  function dependsOnRequest(id: string): boolean {
    if (visiting.has(id)) return fail("参数连线形成循环", [...visiting, id]);
    if (tainted.has(id)) return tainted.get(id)!;
    visiting.add(id);
    const node = nodes.get(id)!;
    let dynamic = ["start", "predicate", "llm", "jev"].includes(node.type);
    for (const binding of incoming.get(id) ?? [])
      if (dependsOnRequest(binding.source)) dynamic = true;
    visiting.delete(id);
    tainted.set(id, dynamic);
    return dynamic;
  }
  for (const node of flow.nodes) dependsOnRequest(node.id);
  const deferred = new Map<string, boolean>();
  function needsDataGraph(id: string): boolean {
    if (deferred.has(id)) return deferred.get(id)!;
    const node = nodes.get(id)!;
    const result = ["text", "format", "template", "replace", "llm", "jev"].includes(node.type) ||
      (incoming.get(id) ?? []).some((binding) => needsDataGraph(binding.source));
    deferred.set(id, result);
    return result;
  }
  for (const binding of flow.bindings ?? []) {
    const field = inputsFor(binding.target).find(
      (item) => item.path === binding.input,
    )!;
    const target = nodes.get(binding.target)!;
    const dynamicTarget = dependsOnRequest(binding.source) &&
      ((target.type === "upstream" && binding.input === "target") ||
        (target.type === "llm" && binding.input === "model"));
    if (dynamicTarget) {
      const allowedField = target.type === "llm" ? "allowedModels" : "allowedTargets";
      const allowed = target.type === "llm" ? target.allowedModels : target.type === "upstream" ? target.allowedTargets : undefined;
      if ((!Array.isArray(allowed) || !allowed.length) &&
          !targets.has(binding.target + "\0" + allowedField))
        fail("动态模型目标需要配置允许列表", [binding.target]);
    }
    if (field.sensitive && dependsOnRequest(binding.source) && !dynamicTarget)
      fail("此参数只允许受控的静态输入", [binding.source, binding.target]);
  }
  const result = structuredClone(flow);
  const resultNodes = new Map(result.nodes.map((node) => [node.id, node]));
  if (personal && context.personalInterfaces)
    for (const node of result.nodes)
      if (
        node.type === "provider" &&
        (incoming.get(node.id) ?? []).some(
          (binding) =>
            binding.target === node.id &&
            binding.input.startsWith("interfaces."),
        )
      )
        node.interfaces = structuredClone(context.personalInterfaces);
  function getOutput(id: string, output: string): unknown {
    const node = nodes.get(id)!;
    if (node.type === "start") {
      if (!request) return undefined;
      switch (output) {
        case "requestedModel":
          return context.requestedModel ?? request.model;
        case "mappedModel":
          return context.mappedModel ?? request.model;
        case "ingressProtocol":
          return context.ingressProtocol;
        case "stream":
          return request.stream;
        case "hasTools":
          return request.tools.length > 0 || !!request.webSearch;
        case "textLength":
          return request.messages.reduce(
            (sum, message) => sum + message.text.length,
            0,
          );
        case "text":
          return [...request.messages].reverse().find((message) => message.role === "user")?.text ?? "";
        case "messages":
          return structuredClone(request.messages);
      }
    }
    if (node.type === "value") {
      const incoming = targets.get(
        id + "\0" + (node.valueType === "secret" ? "secretRef" : "value"),
      );
      if (incoming) return getOutput(incoming.source, incoming.output);
      return node.valueType === "secret" ? node.secretRef : node.value;
    }
    if (node.type === "predicate" || node.type === "compare" || node.type === "logic") {
      const effective = structuredClone(node);
      for (const binding of incoming.get(id) ?? []) {
        const field = inputsFor(id).find((item) => item.path === binding.input)!;
        const value = getOutput(binding.source, binding.output);
        if (!validValue(field.type, value))
          fail("参数来源没有有效值", [binding.source, binding.target]);
        setPath(effective, binding.input, value, fail);
      }
      if (effective.type === "compare") return evaluateCompare(effective);
      if (effective.type === "logic") return evaluateLogic(effective);
      return request ? evaluatePredicate(effective, request, context) : undefined;
    }
    return undefined;
  }
  for (const binding of flow.bindings ?? []) {
    if (onlyTargetId && binding.target !== onlyTargetId) continue;
    if (!request && (dependsOnRequest(binding.source) || needsDataGraph(binding.source))) continue;
    const target = resultNodes.get(binding.target)!;
    const field = inputsFor(binding.target).find(
      (item) => item.path === binding.input,
    )!;
    const value = getOutput(binding.source, binding.output);
    if (!validValue(field.type, value))
      fail("参数来源没有有效值", [binding.source, binding.target]);
    setPath(target, binding.input, value, fail);
  }
  if (request)
    for (const binding of flow.bindings ?? []) {
      if (onlyTargetId && binding.target !== onlyTargetId) continue;
      if (!dependsOnRequest(binding.source)) continue;
      const target = resultNodes.get(binding.target)!;
      if (target.type === "upstream" && binding.input === "target" &&
          !target.allowedTargets?.includes(target.target))
        fail("动态目标不在允许列表中", [target.id]);
      if (target.type === "llm" && binding.input === "model" &&
          !target.allowedModels?.includes(target.model))
        fail("动态模型不在允许列表中", [target.id]);
    }
  return result;
}

export function resolveWorkflowStatic(
  flow: ChannelWorkflow,
  personalInterfaces?: UpstreamInterface[],
  personal = false,
): ChannelWorkflow {
  return resolveWorkflowBindings(flow, { personalInterfaces, personal });
}
