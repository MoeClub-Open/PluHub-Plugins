import type { ChannelWorkflow, WorkflowNode } from "@pluhub/contracts/workflow";

export type WorkflowPort = "next" | "yes" | "no" | "fallback";
export const workflowOutputs = (
  node: WorkflowNode,
): { field: WorkflowPort; target: string }[] =>
  node.type === "provider"
    ? [{ field: "fallback", target: node.fallback ?? "" }]
    : node.type === "condition" || node.type === "branch"
      ? [
          { field: "yes", target: node.yes },
          { field: "no", target: node.no },
        ]
      : "next" in node
        ? [{ field: "next", target: node.next }]
        : [];

export function workflowNodePositions(
  flow: ChannelWorkflow,
  sizes?: Map<string, { height?: number }>,
) {
  const columns = new Map<string, number>();
  const visit = (id: string, depth: number, seen: Set<string>) => {
    if (seen.has(id) || depth > 128 || (columns.get(id) ?? -1) >= depth) return;
    columns.set(id, depth);
    const node = flow.nodes.find((item) => item.id === id);
    if (node)
      for (const edge of workflowOutputs(node))
        if (edge.target) visit(edge.target, depth + 1, new Set([...seen, id]));
  };
  visit(flow.entry, 0, new Set());
  const rows = new Map<number, number>();
  return new Map(
    flow.nodes.map((node) => {
      const column = columns.get(node.id) ?? 0,
        y = rows.get(column) ?? 40;
      rows.set(column, y + (sizes?.get(node.id)?.height ?? 210) + 50);
      return [node.id, flow.layout?.[node.id] ?? { x: 40 + column * 370, y }];
    }),
  );
}

export function removeFlowNodes(
  flow: ChannelWorkflow,
  ids: readonly string[],
): ChannelWorkflow {
  const removed = new Set(ids.filter((id) => id !== flow.entry));
  return {
    ...flow,
    bindings: flow.bindings?.filter(
      (edge) => !removed.has(edge.source) && !removed.has(edge.target),
    ),
    layout: Object.fromEntries(
      Object.entries(flow.layout ?? {}).filter(([id]) => !removed.has(id)),
    ),
    nodes: flow.nodes
      .filter((node) => !removed.has(node.id))
      .map((node) => ({
        ...node,
        ...Object.fromEntries(
          workflowOutputs(node)
            .filter((port) => removed.has(port.target))
            .map((port) => [
              port.field,
              port.field === "fallback" ? undefined : "",
            ]),
        ),
      })) as WorkflowNode[],
  };
}

export function copyFlowSelection(
  flow: ChannelWorkflow,
  ids: readonly string[],
) {
  const selected = new Set(ids.filter((id) => id !== flow.entry));
  const positions = workflowNodePositions(flow);
  return {
    bindings: flow.bindings?.filter(
      (edge) => selected.has(edge.source) && selected.has(edge.target),
    ),
    nodes: structuredClone(
      flow.nodes.filter((node) => selected.has(node.id)),
    ).map(
      (node) =>
        ({
          ...node,
          ...Object.fromEntries(
            workflowOutputs(node)
              .filter((port) => !selected.has(port.target))
              .map((port) => [
                port.field,
                port.field === "fallback" ? undefined : "",
              ]),
          ),
        }) as WorkflowNode,
    ),
    layout: Object.fromEntries(
      [...positions].filter(([id]) => selected.has(id)),
    ),
  };
}

export function pasteFlowSelection(
  flow: ChannelWorkflow,
  selection: ReturnType<typeof copyFlowSelection>,
  position: { x: number; y: number },
) {
  if (
    !selection.nodes.length ||
    flow.nodes.length + selection.nodes.length > 128
  )
    return undefined;
  const used = new Set(flow.nodes.map((node) => node.id));
  const ids = new Map<string, string>();
  for (const node of selection.nodes) {
    let id: string = node.type,
      suffix = 1;
    while (used.has(id)) id = node.type + suffix++;
    ids.set(node.id, id);
    used.add(id);
  }
  const points = selection.nodes.map(
    (node) => selection.layout[node.id] ?? { x: 0, y: 0 },
  );
  const origin = {
    x: Math.min(...points.map((p) => p.x)),
    y: Math.min(...points.map((p) => p.y)),
  };
  return {
    ids: [...ids.values()],
    flow: {
      ...flow,
      bindings: [
        ...(flow.bindings ?? []),
        ...(selection.bindings ?? []).map((edge) => ({
          ...edge,
          source: ids.get(edge.source)!,
          target: ids.get(edge.target)!,
        })),
      ],
      nodes: [
        ...flow.nodes,
        ...structuredClone(selection.nodes).map(
          (node) =>
            ({
              ...node,
              id: ids.get(node.id)!,
              ...Object.fromEntries(
                workflowOutputs(node).map((port) => [
                  port.field,
                  ids.get(port.target) ??
                    (port.field === "fallback" ? undefined : ""),
                ]),
              ),
            }) as WorkflowNode,
        ),
      ],
      layout: {
        ...Object.fromEntries(workflowNodePositions(flow)),
        ...Object.fromEntries(
          selection.nodes.map((node, index) => [
            ids.get(node.id)!,
            {
              x: position.x + points[index]!.x - origin.x,
              y: position.y + points[index]!.y - origin.y,
            },
          ]),
        ),
      },
    },
  };
}
