import type {
  ChannelWorkflow,
  WorkflowNode,
  WorkflowValueType,
} from "@pluhub/contracts/workflow";

/** The first data connection determines a comparison's operand type. */
export function comparisonInputNode(
  node: WorkflowNode,
  sourceType: WorkflowValueType | undefined,
  input: string,
  bindings: NonNullable<ChannelWorkflow["bindings"]>,
): WorkflowNode {
  if (
    node.type !== "compare" ||
    !["left", "right"].includes(input) ||
    bindings.some(
      (binding) => binding.target === node.id && binding.input !== input,
    )
  )
    return node;
  const valueType =
    sourceType === "integer"
      ? "number"
      : sourceType === "string[]" && input === "right"
        ? "string"
        : sourceType;
  if (
    valueType !== "number" &&
    valueType !== "string" &&
    valueType !== "boolean"
  )
    return node;
  const operator =
    sourceType === "string[]"
      ? "matches"
      : node.valueType === valueType
        ? node.operator
        : "eq";
  const initial =
    valueType === "number" ? 0 : valueType === "boolean" ? false : "";
  return {
    ...node,
    valueType,
    operator,
    left: typeof node.left === valueType ? node.left : initial,
    right:
      operator === "matches"
        ? Array.isArray(node.right)
          ? node.right
          : []
        : typeof node.right === valueType
          ? node.right
          : initial,
  };
}

export type WorkflowPort = "next" | "yes" | "no" | "fallback";
export const workflowOutputs = (
  node: WorkflowNode,
): { field: WorkflowPort; target: string }[] =>
  node.type === "start"
    ? (node.next.length ? node.next : [""]).map((target) => ({
        field: "next",
        target,
      }))
    : node.type === "provider"
      ? [{ field: "fallback", target: node.fallback ?? "" }]
      : node.type === "branch"
        ? [
            { field: "yes", target: node.yes },
            { field: "no", target: node.no },
          ]
        : "next" in node
          ? [{ field: "next", target: node.next }]
          : [];

/** Change one edge without replacing other connections from the same entry port. */
export function changeWorkflowConnection(
  node: WorkflowNode,
  field: WorkflowPort,
  previous?: string,
  target?: string,
): WorkflowNode {
  if (node.type === "start" && field === "next") {
    const next = node.next.filter((id) => id !== previous);
    if (target && !next.includes(target)) next.push(target);
    return { ...node, next };
  }
  return {
    ...node,
    [field]: target ?? (field === "fallback" ? undefined : ""),
  } as WorkflowNode;
}

function mapWorkflowConnections(
  node: WorkflowNode,
  map: (target: string) => string | undefined,
): WorkflowNode {
  if (node.type === "start")
    return {
      ...node,
      next: node.next.flatMap((id) => {
        const target = map(id);
        return target ? [target] : [];
      }),
    };
  return {
    ...node,
    ...Object.fromEntries(
      workflowOutputs(node).flatMap((edge) => {
        if (!edge.target) return [];
        const target = map(edge.target);
        return target === edge.target
          ? []
          : [
              [
                edge.field,
                target ?? (edge.field === "fallback" ? undefined : ""),
              ],
            ];
      }),
    ),
  } as WorkflowNode;
}

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
      .map((node) =>
        mapWorkflowConnections(node, (target) =>
          removed.has(target) ? undefined : target,
        ),
      ),
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
    ).map((node) =>
      mapWorkflowConnections(node, (target) =>
        selected.has(target) ? target : undefined,
      ),
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
              ...mapWorkflowConnections(node, (target) => ids.get(target)),
              id: ids.get(node.id)!,
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
