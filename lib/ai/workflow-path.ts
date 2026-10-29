import type { AIRequest, Protocol } from "@pluhub/contracts/ai";
import type {
  ChannelWorkflow,
  WorkflowNode,
  WorkflowResult,
} from "@pluhub/contracts/workflow";
import { validateWorkflowNode } from "./channel-graph.js";
import {
  traverseWorkflow,
  type WorkflowPathResult,
} from "./workflow-traversal.js";
export type { WorkflowPathResult } from "./workflow-traversal.js";

type DataGraph = {
  resolveNode(id: string): Promise<WorkflowNode>;
  beginStep?: () => void;
};

/** Resolve asynchronous inputs while using the same rules as ordinary routing. */
export async function runWorkflowPath(
  profile: string,
  flow: ChannelWorkflow,
  request: AIRequest,
  graph: DataGraph,
  signal: AbortSignal,
  context: {
    ingressProtocol?: Protocol;
    requestedModel?: string;
    mappedModel?: string;
    personal?: boolean;
    personalInterfaces?: import("@pluhub/contracts/ai").UpstreamInterface[];
    chooseEntry?: (candidates: readonly string[]) => string;
  } = {},
  onLimit?: (
    policy: NonNullable<WorkflowResult["requestLimits"]>[number],
  ) => Promise<void>,
): Promise<WorkflowPathResult> {
  const execution = traverseWorkflow(profile, flow, request, signal, context);
  let step = execution.next();
  while (!step.done) {
    if ("limit" in step.value) {
      await onLimit?.(step.value.limit);
      step = execution.next();
      continue;
    }
    graph.beginStep?.();
    const node = await graph.resolveNode(step.value.nodeId);
    validateWorkflowNode(node, flow);
    step = execution.next(node);
  }
  return step.value;
}
