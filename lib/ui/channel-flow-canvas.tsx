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
  useUpdateNodeInternals,
  useNodesInitialized,
  SelectionMode,
  type Node,
  type NodeProps,
  type Edge,
  type Connection,
} from "@xyflow/react";
import type { Upstream, UpstreamInterface } from "@pluhub/contracts/ai";
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
import {
  workflowOutputs as outputs,
  workflowNodePositions,
  removeFlowNodes,
} from "./channel-graph-operations.js";
import { isFlowTextInput, useFlowClipboard } from "./use-flow-clipboard.js";
import {
  workflowParameters,
  workflowDataOutputs,
  canBindWorkflowPorts,
} from "../ai/workflow-parameters.js";
import {
  FlowParameterContext,
  flowTypeColor,
  flowTypeLabel,
} from "./flow-parameter-port.js";
export const workflowNodeLabels: Record<WorkflowNode["type"], string> = {
  get start() {
    return tr("请求入口");
  },
  get value() {
    return tr("参数值");
  },
  get text() {
    return tr("文本内容");
  },
  get template() {
    return tr("文本模板");
  },
  get replace() {
    return tr("文本替换");
  },
  get format() {
    return tr("格式化文本");
  },
  get llm() {
    return tr("LLM 请求");
  },
  get jev() {
    return tr("Jev 请求");
  },
  get response() {
    return tr("返回内容");
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
  get predicate() {
    return tr("请求条件");
  },
  get branch() {
    return tr("分支");
  },
  get compare() {
    return tr("比较");
  },
  get logic() {
    return tr("逻辑运算");
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

type CanvasProps = {
  disabled?: boolean;
  invalidNodes?: readonly string[];
  flow: ChannelWorkflow;
  selected: string;
  channel?: Upstream;
  personalInterfaces?: UpstreamInterface[];
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
  bindings: NonNullable<ChannelWorkflow["bindings"]>;
  personalInterfaces?: UpstreamInterface[];
  disabled?: boolean;
}>(null!);

function ChannelNode({ id, data, selected }: NodeProps<FlowNode>) {
  const context = React.useContext(NodeContext),
    { node } = data;
  const expanded = context.expanded.has(id);
  const expandable = node.type !== "start" || !context.personal;
  const updateNodeInternals = useUpdateNodeInternals();
  const nodeElement = React.useRef<HTMLDivElement>(null);
  const [visibleFields, setVisibleFields] =
    React.useState<ReadonlySet<string>>();
  const parameters = workflowParameters(
    node,
    context.personalInterfaces,
    context.personal,
  );
  const dataOutputs = workflowDataOutputs(node);
  const executionOutputs = outputs(node).filter(
    (port) => port.field !== "fallback" || context.personal,
  );
  const namedOutputs = executionOutputs.filter((port) => port.field !== "next");
  const visibleInputs = parameters.filter((p) =>
    context.bindings.some(
      (edge) => edge.target === id && edge.input === p.path,
    ),
  );
  const hiddenInputs = visibleInputs.filter(
    (p) => !expanded || (visibleFields && !visibleFields.has(p.path)),
  );
  const signature = JSON.stringify([
    parameters.map((p) => [p.path, p.type]),
    dataOutputs.map((p) => [p.path, p.type]),
    visibleInputs.map((p) => p.path),
  ]);
  React.useEffect(() => {
    updateNodeInternals(id);
  }, [id, expanded, signature, updateNodeInternals]);
  React.useLayoutEffect(() => {
    const element = nodeElement.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      const next = new Set(
        [
          ...element.querySelectorAll<HTMLElement>(
            ".flow-parameter[data-flow-parameter]",
          ),
        ]
          .filter((row) => row.getClientRects().length > 0)
          .map((row) => row.dataset.flowParameter!),
      );
      setVisibleFields((previous) =>
        previous &&
        previous.size === next.size &&
        [...next].every((field) => previous.has(field))
          ? previous
          : next,
      );
      updateNodeInternals(id);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const mutation = new MutationObserver(schedule);
    mutation.observe(element, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["hidden", "aria-expanded", "data-state"],
    });
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    element.addEventListener("scroll", schedule, true);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      mutation.disconnect();
      resize.disconnect();
      element.removeEventListener("scroll", schedule, true);
    };
  }, [id, expanded, signature, updateNodeInternals]);
  return (
    <FlowParameterContext.Provider
      value={{
        personalInterfaces: context.personalInterfaces,
        personal: context.personal,
        visibleFields,
      }}
    >
      <div
        ref={nodeElement}
        className={"flow-node" + (selected ? " is-selected" : "")}
        style={
          data.invalid
            ? { outline: "2px solid var(--danger, #dc2626)" }
            : undefined
        }
      >
        {![
          "start", "value", "predicate", "compare", "logic", "text",
          "template", "replace", "format", "llm", "jev",
        ].includes(node.type) && (
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
              {expanded ? (
                <ChevronDown size={14} />
              ) : (
                <ChevronRight size={14} />
              )}
            </button>
          )}
          <strong>{workflowNodeLabels[node.type]}</strong>
          {node.type !== "start" && (
            <>
              <button
                className="ghost icon-button nodrag"
                type="button"
                title={tr("复制节点") + " (Ctrl/Cmd+D)"}
                aria-label={tr("复制节点")}
                disabled={context.disabled}
                onClick={() => context.duplicate(id)}
              >
                <Copy size={13} />
              </button>
              <button
                className="ghost icon-button nodrag"
                type="button"
                title={tr("删除节点") + " (Delete)"}
                aria-label={tr("删除节点")}
                disabled={context.disabled}
                onClick={() => context.remove(id)}
              >
                <Trash2 size={13} />
              </button>
            </>
          )}
        </div>
        {namedOutputs.length > 0 && (
          <div className="flow-execution-ports">
            {namedOutputs.map((port) => (
              <div className="flow-execution-port" key={port.field}>
                <span>
                  {tr(port.field === "fallback" ? "失败后" : port.field === "yes" ? "是" : "否")}
                </span>
                <Handle
                  type="source"
                  position={Position.Right}
                  id={port.field}
                />
              </div>
            ))}
          </div>
        )}
        {!expanded && data.summary && (
          <div className="flow-node-summary">{data.summary}</div>
        )}
        {hiddenInputs.length > 0 && (
          <div className="flow-data-ports">
            {hiddenInputs.map((port) => (
              <div
                className="flow-data-port"
                key={port.path}
                style={
                  {
                    "--flow-param-color": flowTypeColor[port.type],
                  } as React.CSSProperties
                }
              >
                <Handle
                  type="target"
                  position={Position.Left}
                  id={"param:" + port.path}
                  className="flow-data-handle"
                  title={tr(port.label) + " · " + flowTypeLabel(port.type)}
                />
                <span>{tr(port.label)}</span>
                <span>{flowTypeLabel(port.type)}</span>
              </div>
            ))}
          </div>
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
        {dataOutputs.length > 0 && (
          <div className="flow-data-ports">
            {dataOutputs.map((port) => (
              <div
                className="flow-data-port"
                key={port.path}
                style={
                  {
                    "--flow-param-color": flowTypeColor[port.type],
                  } as React.CSSProperties
                }
              >
                <span>{tr(port.label)}</span>
                <span>{flowTypeLabel(port.type)}</span>
                <Handle
                  type="source"
                  position={Position.Right}
                  id={"data:" + port.path}
                  className="flow-data-handle"
                  title={tr(port.label) + " · " + flowTypeLabel(port.type)}
                />
              </div>
            ))}
          </div>
        )}
        {executionOutputs
          .filter((port) => port.field === "next")
          .map((port) => (
            <Handle
              key={port.field}
              type="source"
              position={Position.Right}
              id={port.field}
              style={{ top: 34 }}
            />
          ))}
      </div>
    </FlowParameterContext.Provider>
  );
}
const nodeTypes = { channel: ChannelNode };
function summary(node: WorkflowNode, channel?: Upstream) {
  switch (node.type) {
    case "value":
      return node.valueType === "secret"
        ? tr("密钥")
        : typeof node.value === "string"
          ? node.value.slice(0, 60)
          : (JSON.stringify(node.value) ?? "");
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
    case "predicate":
      if (node.test === "model")
        return (
          tr(
            node.modelSource === "mapped" ? "映射后的模型 ID" : "请求模型 ID",
          ) +
          " · " +
          (node.models?.join(", ") || tr("尚未设置"))
        );
      return tr(
        {
          hasTools: "包含工具",
          stream: "流式请求",
          textLengthAbove: "任务字符数大于",
          protocol: "入口协议为",
        }[node.test],
      );
    case "branch":
      return tr("条件输入");
    case "compare":
      return tr({
        eq: "等于", ne: "不等于", gt: "大于", gte: "大于或等于",
        lt: "小于", lte: "小于或等于", matches: "匹配",
      }[node.operator]);
    case "logic":
      return tr({ and: "且", or: "或", not: "非" }[node.operator]);
    default:
      return "";
  }
}
function graphEdges(flow: ChannelWorkflow): Edge[] {
  const controls = flow.nodes.flatMap((node) =>
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
  const data = (flow.bindings ?? []).flatMap((binding) => {
    const source = flow.nodes.find((node) => node.id === binding.source);
    const target = flow.nodes.find((node) => node.id === binding.target);
    if (!source || !target) return [];
    const port = workflowDataOutputs(source).find(
      (item) => item.path === binding.output,
    );
    return [
      {
        id:
          "binding:" +
          JSON.stringify([
            binding.source,
            binding.output,
            binding.target,
            binding.input,
          ]),
        source: binding.source,
        target: binding.target,
        sourceHandle: "data:" + binding.output,
        targetHandle: "param:" + binding.input,
        type: "default",
        className: "flow-value-edge",
        style: port
          ? { stroke: flowTypeColor[port.type], strokeWidth: 2 }
          : undefined,
      },
    ];
  });
  return [...controls, ...data];
}
function Canvas(props: CanvasProps) {
  const { flow, channel, update, select } = props;
  const graph = useReactFlow<FlowNode>();
  const initialized = useNodesInitialized();
  const fitted = React.useRef(false);
  const container = React.useRef<HTMLDivElement>(null);
  const primary = React.useRef(props.selected);
  const pendingSelection = React.useRef<string[] | undefined>(undefined);
  const reconnecting = React.useRef<Edge | undefined>(undefined);
  const positions = workflowNodePositions(flow);
  const makeNodes = (): FlowNode[] =>
    flow.nodes.map((node) => ({
      id: node.id,
      type: "channel",
      position: positions.get(node.id)!,
      data: {
        node,
        summary: flow.bindings?.some((binding) => binding.target === node.id)
          ? ""
          : summary(node, channel),
        invalid: props.invalidNodes?.includes(node.id),
      },
      dragHandle: ".flow-node-header",
      deletable: node.id !== flow.entry,
      selected: node.id === props.selected,
    }));
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(makeNodes());
  const [edges, setEdges, onEdgesChange] = useEdgesState(graphEdges(flow));
  const clipboard = useFlowClipboard({
    flow,
    graph,
    disabled: props.disabled,
    update,
    select,
    pendingSelection,
    container,
  });
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
    if (initialized && !fitted.current) {
      fitted.current = true;
      void graph.fitView({ padding: 0.15, maxZoom: 1 });
    }
  }, [initialized, graph]);
  React.useEffect(() => {
    const requested =
      pendingSelection.current ??
      (primary.current !== props.selected ? [props.selected] : undefined);
    primary.current = props.selected;
    pendingSelection.current = undefined;
    setNodes((previous) => {
      const current = new Map(previous.map((node) => [node.id, node]));
      return makeNodes().map((node) => ({
        ...current.get(node.id),
        ...node,
        selected: requested
          ? requested.includes(node.id)
          : (current.get(node.id)?.selected ?? node.selected),
      }));
    });
    setEdges((previous) => {
      const selected = new Set(
        previous.filter((edge) => edge.selected).map((edge) => edge.id),
      );
      return graphEdges(flow).map((edge) => ({
        ...edge,
        selected: !requested && selected.has(edge.id),
      }));
    });
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
    if (
      connection.sourceHandle.startsWith("data:") &&
      connection.targetHandle?.startsWith("param:")
    ) {
      const bindings = (flow.bindings ?? []).filter(
        (edge) =>
          !old ||
          edge.source !== old.source ||
          edge.output !== old.sourceHandle?.slice(5) ||
          edge.target !== old.target ||
          edge.input !== old.targetHandle?.slice(6),
      );
      update({
        ...flow,
        layout: Object.fromEntries(positions),
        bindings: [
          ...bindings,
          {
            source: connection.source,
            output: connection.sourceHandle.slice(5),
            target: connection.target,
            input: connection.targetHandle.slice(6),
          },
        ],
      });
      return;
    }
    update({
      ...flow,
      layout: Object.fromEntries(positions),
      nodes: flow.nodes.map((node) => {
        let next = node;
        if (old?.source === next.id)
          next = {
            ...next,
            [old.sourceHandle!]:
              old.sourceHandle === "fallback" ? undefined : "",
          } as WorkflowNode;
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
      !connection.sourceHandle ||
      !connection.targetHandle
    )
      return false;
    const source = flow.nodes.find((node) => node.id === connection.source);
    const target = flow.nodes.find((node) => node.id === connection.target);
    if (!source || !target) return false;
    const dataOutput = connection.sourceHandle.startsWith("data:");
    const dataInput = connection.targetHandle.startsWith("param:");
    if (dataOutput || dataInput) {
      if (
        !dataOutput ||
        !dataInput ||
        (reconnecting.current &&
          !reconnecting.current.sourceHandle?.startsWith("data:"))
      )
        return false;
      const output = connection.sourceHandle.slice(5),
        input = connection.targetHandle.slice(6);
      if (
        !canBindWorkflowPorts(
          source,
          output,
          target,
          input,
          props.personalInterfaces,
          props.personal,
        )
      )
        return false;
      const other = (flow.bindings ?? []).filter(
        (edge) =>
          !reconnecting.current ||
          edge.source !== reconnecting.current.source ||
          edge.output !== reconnecting.current.sourceHandle?.slice(5) ||
          edge.target !== reconnecting.current.target ||
          edge.input !== reconnecting.current.targetHandle?.slice(6),
      );
      if (
        other.some((edge) => edge.target === target.id && edge.input === input)
      )
        return false;
      const bindings = [
        ...other,
        { source: source.id, output, target: target.id, input },
      ];
      const seen = new Set<string>();
      const reachesSource = (id: string): boolean => {
        if (id === source.id) return true;
        if (seen.has(id)) return false;
        seen.add(id);
        return bindings
          .filter((edge) => edge.source === id)
          .some((edge) => reachesSource(edge.target));
      };
      if (reachesSource(target.id)) return false;
      const requestDerived = (
        id: string,
        seen = new Set<string>(),
      ): boolean => {
        if (seen.has(id)) return false;
        seen.add(id);
        const node = flow.nodes.find((item) => item.id === id);
        return (
          node?.type === "start" ||
          node?.type === "predicate" ||
          node?.type === "llm" ||
          node?.type === "jev" ||
          bindings.some(
            (edge) =>
              edge.target === id &&
              requestDerived(edge.source, new Set(seen)),
          )
        );
      };
      return bindings.every((edge) => {
        const node = flow.nodes.find((item) => item.id === edge.target)!;
        const parameter = workflowParameters(
          node,
          props.personalInterfaces,
          props.personal,
        ).find((item) => item.path === edge.input);
        return !parameter?.sensitive || !requestDerived(edge.source);
      });
    }
    if (
      connection.targetHandle !== "in" ||
      connection.target === flow.entry ||
      reconnecting.current?.sourceHandle?.startsWith("data:")
    )
      return false;
    const port = outputs(source).find(
      (port) => port.field === connection.sourceHandle,
    );
    if (!port) return false;
    if (
      port.field === "fallback" &&
      (!props.personal ||
        flow.nodes.find((node) => node.id === connection.target)?.type !==
          "platform")
    )
      return false;
    // Replacing an occupied outlet is explicit: reconnect or remove its existing edge.
    if (
      port.target &&
      !(
        reconnecting.current?.source === connection.source &&
        reconnecting.current.sourceHandle === connection.sourceHandle
      )
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
  return (
    <NodeContext.Provider
      value={{
        personal: props.personal,
        personalInterfaces: props.personalInterfaces,
        bindings: flow.bindings ?? [],
        expanded,
        disabled: props.disabled,
        settings: props.renderSettings,
        duplicate: (id) => clipboard.duplicate([id]),
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
          title={tr("撤销编辑") + " (Ctrl/Cmd+Z)"}
          aria-label={tr("撤销编辑")}
          disabled={props.disabled || !props.canUndo}
          onClick={props.undo}
        >
          <Undo2 size={15} />
        </button>
        <button
          className="secondary icon-button"
          title={tr("重做编辑") + " (Ctrl/Cmd+Shift+Z / Ctrl+Y)"}
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
        {clipboard.warning && (
          <span className="muted" role="status">
            {clipboard.warning}
          </span>
        )}
      </div>
      <div
        ref={container}
        className="channel-flow-canvas"
        aria-label={tr("渠道流程画布")}
        tabIndex={0}
        {...clipboard.handlers}
        onPointerDownCapture={(event) => {
          if (
            !isFlowTextInput(event.target) &&
            !(event.target as HTMLElement).closest(
              "button, .flow-node-settings",
            )
          )
            container.current?.focus({ preventScroll: true });
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
          onNodeClick={(_, node) => {
            primary.current = node.id;
            select(node.id);
          }}
          onPaneClick={() => {
            primary.current = "";
            select("");
          }}
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
          onReconnectStart={(_, edge) => {
            reconnecting.current = edge;
          }}
          onReconnectEnd={() => {
            reconnecting.current = undefined;
          }}
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
              bindings: next.bindings?.filter(
                (binding) =>
                  !disconnected.some(
                    (edge) =>
                      edge.sourceHandle?.startsWith("data:") &&
                      edge.source === binding.source &&
                      edge.sourceHandle.slice(5) === binding.output &&
                      edge.target === binding.target &&
                      edge.targetHandle?.slice(6) === binding.input,
                  ),
              ),
              nodes: next.nodes.map((node) => {
                const patch = Object.fromEntries(
                  disconnected
                    .filter(
                      (edge) =>
                        edge.source === node.id &&
                        !edge.sourceHandle?.startsWith("data:"),
                    )
                    .map((edge) => [
                      edge.sourceHandle!,
                      edge.sourceHandle === "fallback" ? undefined : "",
                    ]),
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
          minZoom={0.2}
          maxZoom={2}
          panOnDrag={[1, 2]}
          panActivationKeyCode="Space"
          selectionOnDrag
          selectionMode={SelectionMode.Partial}
          deleteKeyCode={props.disabled ? null : ["Backspace", "Delete"]}
          selectionKeyCode="Shift"
          multiSelectionKeyCode={["Control", "Meta", "Shift"]}
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
