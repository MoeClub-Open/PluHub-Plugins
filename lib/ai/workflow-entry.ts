import type { ChannelWorkflow } from "@pluhub/contracts/workflow";
import type { AIRequest } from "@pluhub/contracts/ai";
import { resolveWorkflowBindings } from "./workflow-bindings.js";
import { computedWorkflowTypes } from "./workflow-node-validation.js";

/** Filter entry paths by their configured providers without making upstream calls. */
export function workflowEntryCandidates(
  flow: ChannelWorkflow,
  request: AIRequest,
  context: Parameters<typeof resolveWorkflowBindings>[1] = {},
) {
  const model = context?.mappedModel ?? request.model;
  const resolved = resolveWorkflowBindings(flow, context);
  const nodes = new Map(resolved.nodes.map((node) => [node.id, node]));
  const entry = nodes.get(flow.entry);
  if (entry?.type !== "start") return [];
  const deferred = new Map<string, boolean>();
  const needsDataGraph = (id: string): boolean => {
    if (deferred.has(id)) return deferred.get(id)!;
    const value =
      computedWorkflowTypes.has(nodes.get(id)?.type ?? "") ||
      (flow.bindings ?? []).some(
        (binding) => binding.target === id && needsDataGraph(binding.source),
      );
    deferred.set(id, value);
    return value;
  };
  const accepts = (id: string, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    const node = nodes.get(id);
    if (!node) return false;
    if (node.type === "provider")
      return !node.modelMap || Object.hasOwn(node.modelMap, model);
    if (node.type === "branch") {
      if (!needsDataGraph(id)) {
        const branch = resolveWorkflowBindings(
          flow,
          context,
          request,
          undefined,
          id,
        ).nodes.find((item) => item.id === id)!;
        if (branch.type === "branch")
          return accepts(branch.condition ? branch.yes : branch.no, seen);
      }
      return (
        accepts(node.yes, new Set(seen)) || accepts(node.no, new Set(seen))
      );
    }
    if (node.type === "start")
      return node.next.some((target) => accepts(target, new Set(seen)));
    if ("next" in node) return accepts(node.next, seen);
    return ["routing", "upstream", "platform", "response"].includes(node.type);
  };
  return entry.next.filter((target) => accepts(target));
}
