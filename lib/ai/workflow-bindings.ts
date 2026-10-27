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

function validValue(type: WorkflowValueType, value: unknown): boolean {
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
    case "secret":
      return (
        typeof value === "string" ||
        (Array.isArray(value) &&
          value.every((item) => typeof item === "string"))
      );
  }
}

function setPath(node: WorkflowNode, path: string, value: unknown) {
  const parts = path.split(".");
  let target: any = node;
  for (const [index, key] of parts.slice(0, -1).entries()) {
    if (target[key] === undefined)
      target[key] = /^\d+$/.test(parts[index + 1]!) ? [] : {};
    target = target[key];
  }
  target[parts.at(-1)!] = structuredClone(value);
}

/** Validate typed connections and evaluate either constant inputs or a full request. */
export function resolveWorkflowBindings(
  flow: ChannelWorkflow,
  context: Context = {},
  request?: AIRequest,
  fail: Fail = defaultFail,
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
    let dynamic = node.type === "start";
    for (const binding of incoming.get(id) ?? [])
      if (dependsOnRequest(binding.source)) dynamic = true;
    visiting.delete(id);
    tainted.set(id, dynamic);
    return dynamic;
  }
  for (const node of flow.nodes) dependsOnRequest(node.id);
  for (const binding of flow.bindings ?? []) {
    const field = inputsFor(binding.target).find(
      (item) => item.path === binding.input,
    )!;
    if (field.sensitive && dependsOnRequest(binding.source))
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
      }
    }
    if (node.type === "value") {
      const incoming = targets.get(
        id + "\0" + (node.valueType === "secret" ? "secretRef" : "value"),
      );
      if (incoming) return getOutput(incoming.source, incoming.output);
      return node.valueType === "secret" ? node.secretRef : node.value;
    }
    return undefined;
  }
  for (const binding of flow.bindings ?? []) {
    if (!request && dependsOnRequest(binding.source)) continue;
    const target = resultNodes.get(binding.target)!;
    const field = inputsFor(binding.target).find(
      (item) => item.path === binding.input,
    )!;
    const value = getOutput(binding.source, binding.output);
    if (!validValue(field.type, value))
      fail("参数来源没有有效值", [binding.source, binding.target]);
    setPath(target, binding.input, value);
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
