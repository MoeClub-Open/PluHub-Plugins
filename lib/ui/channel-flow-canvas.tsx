import React from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  useReactFlow,
  useNodesState,
  useEdgesState,
  type Node,
  type NodeProps,
  type Edge,
  type Connection,
} from "@xyflow/react";
import type { Upstream } from "@pluhub/contracts/ai";
import type { ChannelWorkflow, WorkflowNode } from "@pluhub/contracts/workflow";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Trash2,
  Undo2,
  Redo2,
  LayoutGrid,
} from "lucide-react";
import { t as tr } from "./i18n.js";
export const workflowNodeLabels: Record<WorkflowNode["type"], string> = {
  get start() {
    return tr("请求入口");
  },
  get provider() {
    return tr("调用上游");
  },
  get platform() {
    return tr("平台分组");
  },
  get routing() {
    return tr("自动路由");
  },
  get condition() {
    return tr("条件分支");
  },
  get protocol() {
    return tr("协议准入");
  },
  get prompt() {
    return tr("系统提示词");
  },
  get reasoning() {
    return tr("思考强度");
  },
  get maxTokens() {
    return tr("输出预算");
  },
  get tps() {
    return tr("输出 TPS");
  },
  get rateLimit() {
    return tr("请求限流");
  },
  get upstream() {
    return tr("转到其他模型");
  },
};

type Port = "next" | "yes" | "no" | "fallback";
const outputs = (node: WorkflowNode): { field: Port; target: string }[] =>
  node.type === "provider" && node.fallback
    ? [{ field: "fallback", target: node.fallback }]
    : node.type === "condition"
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
    if (seen.has(id) || depth > 64 || (columns.get(id) ?? -1) >= depth) return;
    columns.set(id, depth);
    const node = flow.nodes.find((item) => item.id === id);
    if (node)
      for (const edge of outputs(node))
        visit(edge.target, depth + 1, new Set([...seen, id]));
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
  let next = flow;
  for (const id of ids) {
    if (id === flow.entry) continue;
    const target = next.nodes.find((node) => node.id === id);
    if (!target) continue;
    const fallback = "next" in target ? target.next : "";
    next = {
      ...next,
      layout: Object.fromEntries(
        Object.entries(next.layout ?? {}).filter(([key]) => key !== id),
      ),
      nodes: next.nodes
        .filter((node) => node.id !== id)
        .map((node) =>
          node.type === "provider" && node.fallback === id
            ? { ...node, fallback: undefined }
            : node.type === "condition"
              ? {
                  ...node,
                  yes: node.yes === id ? fallback : node.yes,
                  no: node.no === id ? fallback : node.no,
                }
              : "next" in node && node.next === id
                ? { ...node, next: fallback }
                : node,
        ),
    };
  }
  return next;
}

type CanvasProps = {
  disabled?: boolean;
  invalidNodes?: readonly string[];
  flow: ChannelWorkflow;
  selected: string;
  channel?: Upstream;
  personal: boolean;
  select: (id: string) => void;
  update: (flow: ChannelWorkflow) => void;
  add: (type: WorkflowNode["type"], position: { x: number; y: number }) => void;
  renderSettings: (id: string) => React.ReactNode;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
};
type FlowNode = Node<
  { node: WorkflowNode; summary: string; invalid?: boolean },
  "channel"
>;
const NodeContext = React.createContext<{
  personal: boolean;
  expanded: ReadonlySet<string>;
  toggle: (id: string) => void;
  settings: (id: string) => React.ReactNode;
  remove: (id: string) => void;
  duplicate: (id: string) => void;
  disabled?: boolean;
}>(null!);

function ChannelNode({ id, data, selected }: NodeProps<FlowNode>) {
  const context = React.useContext(NodeContext),
    { node } = data;
  const expanded = context.expanded.has(id);
  const expandable = node.type !== "start" || !context.personal;
  return (
    <div
      className={"flow-node" + (selected ? " is-selected" : "")}
      style={
        data.invalid
          ? { outline: "2px solid var(--danger, #dc2626)" }
          : undefined
      }
    >
      {node.type !== "start" && (
        <Handle type="target" position={Position.Left} id="in" />
      )}
      <div
        className="flow-node-header"
        onDoubleClick={expandable ? () => context.toggle(id) : undefined}
      >
        {expandable && (
          <button
            className="ghost icon-button nodrag"
            type="button"
            aria-label={tr(expanded ? "收起设置" : "展开设置")}
            onClick={() => context.toggle(id)}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        )}
        <strong>{workflowNodeLabels[node.type]}</strong>
        {node.type !== "start" && (
          <>
            <button
              className="ghost icon-button nodrag"
              type="button"
              title={tr("复制节点")}
              aria-label={tr("复制节点")}
              disabled={context.disabled}
              onClick={() => context.duplicate(id)}
            >
              <Copy size={13} />
            </button>
            <button
              className="ghost icon-button nodrag"
              type="button"
              title={tr("删除节点")}
              aria-label={tr("删除节点")}
              disabled={context.disabled}
              onClick={() => context.remove(id)}
            >
              <Trash2 size={13} />
            </button>
          </>
        )}
      </div>
      {!expanded && data.summary && (
        <div className="flow-node-summary">{data.summary}</div>
      )}
      {expandable && expanded && (
        <fieldset
          disabled={context.disabled}
          className="flow-node-settings nodrag nowheel"
          style={{ border: 0, margin: 0, minWidth: 0 }}
        >
          {context.settings(id)}
        </fieldset>
      )}
      {outputs(node).map((port, index) => (
        <React.Fragment key={port.field}>
          {(node.type === "condition" || port.field === "fallback") && (
            <span className="flow-port-label" style={{ top: 42 + index * 24 }}>
              {tr(
                port.field === "fallback"
                  ? "失败后"
                  : port.field === "yes"
                    ? "是"
                    : "否",
              )}
            </span>
          )}
          <Handle
            type="source"
            position={Position.Right}
            id={port.field}
            style={{ top: node.type === "condition" ? 48 + index * 24 : 34 }}
          />
        </React.Fragment>
      ))}
    </div>
  );
}
const nodeTypes = { channel: ChannelNode };
function summary(node: WorkflowNode, channel?: Upstream) {
  switch (node.type) {
    case "provider":
      return node.upstream?.protocol ?? channel?.protocol ?? tr("尚未配置上游");
    case "protocol":
      return (
        node.allow.length +
        tr(" 种入口 · ") +
        tr(node.conversion === "auto" ? "自动转换" : "仅同协议")
      );
    case "platform":
      return node.model || tr("平台分组");
    case "routing":
      return node.profile;
    case "upstream":
      return node.target || tr("请选择模型");
    case "reasoning":
      return node.effort;
    case "maxTokens":
      return node.limit + " tokens";
    case "tps":
      return (node.rate ?? node.aggregateRate) + " token/s";
    case "rateLimit":
      return Object.entries(node.rule)
        .map(([key, value]) => value + " " + key)
        .join(" · ");
    case "prompt":
      return node.text.slice(0, 60) || tr("系统提示词");
    case "condition":
      return tr(
        {
          hasTools: "包含工具",
          stream: "流式请求",
          textLengthAbove: "任务字符数大于",
          protocol: "入口协议为",
        }[node.test],
      );
    default:
      return "";
  }
}
function graphEdges(flow: ChannelWorkflow): Edge[] {
  return flow.nodes.flatMap((node) =>
    outputs(node)
      .filter((port) => flow.nodes.some((item) => item.id === port.target))
      .map((port) => ({
        id: node.id + ":" + port.field,
        source: node.id,
        target: port.target,
        sourceHandle: port.field,
        targetHandle: "in",
        type: "default",
      })),
  );
}
function Canvas(props: CanvasProps) {
  const { flow, channel, update, select } = props;
  const graph = useReactFlow<FlowNode>();
  const positions = workflowNodePositions(flow);
  const makeNodes = (): FlowNode[] =>
    flow.nodes.map((node) => ({
      id: node.id,
      type: "channel",
      position: positions.get(node.id)!,
      data: {
        node,
        summary: summary(node, channel),
        invalid: props.invalidNodes?.includes(node.id),
      },
      dragHandle: ".flow-node-header",
      deletable: node.id !== flow.entry,
      selected: node.id === props.selected,
    }));
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(makeNodes());
  const [edges, setEdges, onEdgesChange] = useEdgesState(graphEdges(flow));
  const [expanded, setExpanded] = React.useState<Set<string>>(
    () =>
      new Set(
        flow.nodes
          .filter((n) => n.type === "provider")
          .slice(0, 1)
          .map((n) => n.id),
      ),
  );
  React.useEffect(() => {
    setNodes(makeNodes());
    setEdges(graphEdges(flow));
  }, [flow, channel, props.selected, props.invalidNodes]);
  React.useEffect(() => {
    const id = props.invalidNodes?.[0];
    if (id)
      void graph.fitView({
        nodes: [{ id }],
        padding: 0.5,
        maxZoom: 1,
        duration: 200,
      });
  }, [props.invalidNodes]);
  const connect = (connection: Connection, old?: Edge) => {
    if (props.disabled) return;
    if (!connection.source || !connection.target || !connection.sourceHandle)
      return;
    update({
      ...flow,
      layout: Object.fromEntries(positions),
      nodes: flow.nodes.map((node) => {
        let next = node;
        if (old?.source === next.id)
          next = { ...next, [old.sourceHandle!]: "" } as WorkflowNode;
        if (connection.source === next.id)
          next = {
            ...next,
            [connection.sourceHandle!]: connection.target,
          } as WorkflowNode;
        return next;
      }),
    });
  };
  const validConnection = (connection: Connection | Edge) => {
    if (
      !connection.source ||
      !connection.target ||
      connection.source === connection.target ||
      connection.target === flow.entry
    )
      return false;
    const seen = new Set<string>();
    const reachesSource = (id: string): boolean => {
      if (id === connection.source) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      const node = flow.nodes.find((n) => n.id === id);
      return !!node && outputs(node).some((edge) => reachesSource(edge.target));
    };
    return !reachesSource(connection.target);
  };
  function duplicate(id: string) {
    const original = flow.nodes.find((node) => node.id === id);
    if (
      props.disabled ||
      !original ||
      original.type === "start" ||
      flow.nodes.length >= 64
    )
      return;
    let copy = original.type,
      n = 1;
    while (flow.nodes.some((node) => node.id === copy))
      copy = (original.type + n++) as typeof copy;
    const point = { ...positions.get(id)! };
    const occupied = graph.getNodes();
    do {
      point.y += 80;
    } while (
      occupied.some(
        (node) =>
          Math.abs(node.position.x - point.x) <
            (node.measured?.width ?? 320) + 30 &&
          point.y < node.position.y + (node.measured?.height ?? 210) + 30 &&
          point.y + (graph.getNode(id)?.measured?.height ?? 210) + 30 >
            node.position.y,
      )
    );
    update({
      ...flow,
      nodes: [...flow.nodes, { ...structuredClone(original), id: copy }],
      layout: { ...Object.fromEntries(positions), [copy]: point },
    });
    select(copy);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        void graph.fitView({
          nodes: [{ id: copy }],
          padding: 0.5,
          maxZoom: 1,
          duration: 200,
        });
      }),
    );
  }
  return (
    <NodeContext.Provider
      value={{
        personal: props.personal,
        expanded,
        disabled: props.disabled,
        settings: props.renderSettings,
        duplicate,
        remove: (id) => {
          if (props.disabled) return;
          update(
            removeFlowNodes(
              { ...flow, layout: Object.fromEntries(positions) },
              [id],
            ),
          );
          select(flow.entry);
        },
        toggle: (id) =>
          setExpanded((old) => {
            const next = new Set(old);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          }),
      }}
    >
      <div className="workflow-tools flow-history">
        <button
          className="secondary icon-button"
          title={tr("撤销编辑")}
          aria-label={tr("撤销编辑")}
          disabled={props.disabled || !props.canUndo}
          onClick={props.undo}
        >
          <Undo2 size={15} />
        </button>
        <button
          className="secondary icon-button"
          title={tr("重做编辑")}
          aria-label={tr("重做编辑")}
          disabled={props.disabled || !props.canRedo}
          onClick={props.redo}
        >
          <Redo2 size={15} />
        </button>
        <button
          className="secondary"
          disabled={props.disabled}
          onClick={() => {
            const sizes = new Map(
              graph.getNodes().map((node) => [node.id, node.measured ?? {}]),
            );
            update({
              ...flow,
              layout: Object.fromEntries(
                workflowNodePositions({ ...flow, layout: undefined }, sizes),
              ),
            });
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                void graph.fitView({ padding: 0.15 });
              }),
            );
          }}
        >
          <LayoutGrid size={14} />
          {tr("自动排列")}
        </button>
      </div>
      <div
        className="channel-flow-canvas"
        aria-label={tr("渠道流程画布")}
        onKeyDown={(event) => {
          if (props.disabled) return;
          const target = event.target as HTMLElement;
          if (target.closest("input, textarea, select, [contenteditable=true]"))
            return;
          if (
            (event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === "z"
          ) {
            event.preventDefault();
            event.shiftKey ? props.redo() : props.undo();
          }
        }}
      >
        <ReactFlow<FlowNode>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          nodesDraggable={!props.disabled}
          nodesConnectable={!props.disabled}
          edgesReconnectable={!props.disabled}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={(_, node) => select(node.id)}
          onNodeDragStop={(_, node, moved) => {
            update({
              ...flow,
              layout: {
                ...Object.fromEntries(positions),
                ...Object.fromEntries(
                  (moved.length ? moved : [node]).map((item) => [
                    item.id,
                    item.position,
                  ]),
                ),
              },
            });
          }}
          onConnect={(connection) => connect(connection)}
          onReconnect={(edge, connection) => connect(connection, edge)}
          isValidConnection={validConnection}
          onDelete={({ nodes: deleted, edges: links }) => {
            if (props.disabled) return;
            const next = removeFlowNodes(
              { ...flow, layout: Object.fromEntries(positions) },
              deleted.map((node) => node.id),
            );
            const removed = new Set(deleted.map((node) => node.id));
            const disconnected = links.filter(
              (edge) => !removed.has(edge.source) && !removed.has(edge.target),
            );
            update({
              ...next,
              nodes: next.nodes.map((node) => {
                const patch = Object.fromEntries(
                  disconnected
                    .filter((edge) => edge.source === node.id)
                    .map((edge) => [edge.sourceHandle!, ""]),
                );
                return { ...node, ...patch } as WorkflowNode;
              }),
            });
            select(flow.entry);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }}
          onDrop={(event) => {
            event.preventDefault();
            if (props.disabled) return;
            const type = event.dataTransfer.getData(
              "application/pluhub-node",
            ) as WorkflowNode["type"];
            if (type !== "start" && Object.hasOwn(workflowNodeLabels, type))
              props.add(
                type,
                graph.screenToFlowPosition({
                  x: event.clientX,
                  y: event.clientY,
                }),
              );
          }}
          fitView
          minZoom={0.2}
          maxZoom={2}
          panOnDrag={[0, 1]}
          deleteKeyCode={props.disabled ? null : ["Backspace", "Delete"]}
          selectionKeyCode="Shift"
          multiSelectionKeyCode={["Control", "Meta"]}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </NodeContext.Provider>
  );
}
export function ChannelFlowCanvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
