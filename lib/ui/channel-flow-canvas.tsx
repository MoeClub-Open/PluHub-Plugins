import React from "react";
import type { Upstream } from "@pluhub/contracts/ai";
import type { ChannelWorkflow, WorkflowNode } from "@pluhub/contracts/workflow";
import { t as tr } from "./i18n.js";

export const workflowNodeLabels: Record<WorkflowNode["type"], string> = {
  get start() {
    return tr("请求入口");
  },
  get provider() {
    return tr("调用上游");
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

type FlowEdgeField = "next" | "yes" | "no";
type FlowEdge = {
  field: FlowEdgeField;
  target: string;
  y: number;
  label?: string;
};

const outgoing = (node: WorkflowNode): FlowEdge[] =>
  node.type === "condition"
    ? [
        {
          field: "yes",
          target: node.yes,
          y: 24,
          label: tr("是"),
        },
        {
          field: "no",
          target: node.no,
          y: 50,
          label: tr("否"),
        },
      ]
    : "next" in node
      ? [{ field: "next", target: node.next, y: 35 }]
      : [];

export function workflowNodePositions(flow: ChannelWorkflow) {
  const columns = new Map<string, number>();
  const visit = (key: string, depth: number, seen: Set<string>) => {
    if (seen.has(key) || depth > 64 || (columns.get(key) ?? -1) >= depth)
      return;
    columns.set(key, depth);
    const node = flow.nodes.find((item) => item.id === key);
    if (node)
      for (const edge of outgoing(node))
        visit(edge.target, depth + 1, new Set([...seen, key]));
  };
  visit(flow.entry, 0, new Set());
  const rows = new Map<number, number>();
  const automatic = new Map(
    flow.nodes.map((node) => {
      const column = columns.get(node.id) ?? 0;
      const row = rows.get(column) ?? 0;
      rows.set(column, row + 1);
      return [node.id, { x: 20 + column * 205, y: 20 + row * 105 }];
    }),
  );
  return new Map(
    flow.nodes.map((node) => [
      node.id,
      flow.layout?.[node.id] ?? automatic.get(node.id)!,
    ]),
  );
}

export function ChannelFlowCanvas({
  flow,
  selected,
  channel,
  personal,
  select,
  update,
}: {
  flow: ChannelWorkflow;
  selected: string;
  channel?: Upstream;
  personal: boolean;
  select: (id: string) => void;
  update: (flow: ChannelWorkflow) => void;
}) {
  const canvas = React.useRef<HTMLElement>(null);
  const svgCanvas = React.useRef<SVGSVGElement>(null);
  const [zoom, setZoom] = React.useState(1);
  const [movingNode, setMovingNode] = React.useState<{
    id: string;
    pointerId: number;
    offsetX: number;
    offsetY: number;
  }>();
  const [linking, setLinking] = React.useState<{
    from: string;
    field: FlowEdgeField;
    pointerId: number;
    current: { x: number; y: number };
  }>();
  const [linkTarget, setLinkTarget] = React.useState<string>();
  const points = workflowNodePositions(flow);
  const width = Math.max(
    420,
    ...[...points.values()].map((point) => point.x + 190),
  );
  const height = Math.max(
    260,
    ...[...points.values()].map((point) => point.y + 95),
  );
  const pointFromEvent = (clientX: number, clientY: number) => {
    const svg = svgCanvas.current;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return { x: 0, y: 0 };
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const local = point.matrixTransform(matrix.inverse());
    return { x: local.x, y: local.y };
  };
  const curve = (
    from: { x: number; y: number },
    to: { x: number; y: number },
    fromY: number,
  ) => {
    const bend = Math.max(55, Math.abs(to.x - from.x) * 0.45);
    return `M${from.x + 170},${from.y + fromY} C${from.x + 170 + bend},${from.y + fromY} ${to.x - bend},${to.y + 35} ${to.x},${to.y + 35}`;
  };
  React.useLayoutEffect(() => {
    if (canvas.current)
      setZoom(
        Math.max(0.75, Math.min(1, (canvas.current.clientWidth - 32) / width)),
      );
  }, [channel?.name, flow.entry, flow.nodes.length]);
  function startMovingNode(
    event: React.PointerEvent<SVGGElement>,
    id: string,
    point: { x: number; y: number },
  ) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    select(id);
    const pointer = pointFromEvent(event.clientX, event.clientY);
    setMovingNode({
      id,
      pointerId: event.pointerId,
      offsetX: pointer.x - point.x,
      offsetY: pointer.y - point.y,
    });
    svgCanvas.current?.setPointerCapture(event.pointerId);
  }
  function startLinking(
    event: React.PointerEvent<SVGCircleElement>,
    from: string,
    field: FlowEdgeField,
  ) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    select(from);
    const current = pointFromEvent(event.clientX, event.clientY);
    setLinking({ from, field, pointerId: event.pointerId, current });
    svgCanvas.current?.setPointerCapture(event.pointerId);
  }
  function movePointer(event: React.PointerEvent<SVGSVGElement>) {
    const pointer = pointFromEvent(event.clientX, event.clientY);
    if (movingNode?.pointerId === event.pointerId) {
      update({
        ...flow,
        layout: {
          ...flow.layout,
          [movingNode.id]: {
            x: Math.max(0, pointer.x - movingNode.offsetX),
            y: Math.max(0, pointer.y - movingNode.offsetY),
          },
        },
      });
    }
    if (linking?.pointerId === event.pointerId) {
      setLinkTarget(
        document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest("[data-input-node]")
          ?.getAttribute("data-input-node") ?? undefined,
      );
      setLinking({ ...linking, current: pointer });
    }
  }
  function endPointer(event: React.PointerEvent<SVGSVGElement>) {
    if (movingNode?.pointerId === event.pointerId) {
      if (svgCanvas.current?.hasPointerCapture(event.pointerId))
        svgCanvas.current.releasePointerCapture(event.pointerId);
      setMovingNode(undefined);
    }
    if (linking?.pointerId === event.pointerId) {
      if (svgCanvas.current?.hasPointerCapture(event.pointerId))
        svgCanvas.current.releasePointerCapture(event.pointerId);
      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest("[data-input-node]")
        ?.getAttribute("data-input-node");
      if (target && target !== linking.from) {
        update({
          ...flow,
          nodes: flow.nodes.map((node) =>
            node.id === linking.from
              ? ({ ...node, [linking.field]: target } as WorkflowNode)
              : node,
          ),
        });
        select(target);
      }
      setLinkTarget(undefined);
      setLinking(undefined);
    }
  }
  const linkingNode = linking
    ? flow.nodes.find((node) => node.id === linking.from)
    : undefined;
  const linkingPoint = linking ? points.get(linking.from) : undefined;
  const linkingOffset =
    linking && linkingNode
      ? (outgoing(linkingNode).find((edge) => edge.field === linking.field)
          ?.y ?? 35)
      : 35;
  const linkingPath =
    linking && linkingPoint
      ? (() => {
          const from = {
            x: linkingPoint.x + 170,
            y: linkingPoint.y + linkingOffset,
          };
          const bend = Math.max(
            55,
            Math.abs(linking.current.x - from.x) * 0.45,
          );
          return `M${from.x},${from.y} C${from.x + bend},${from.y} ${linking.current.x - bend},${linking.current.y} ${linking.current.x},${linking.current.y}`;
        })()
      : undefined;
  return (
    <div>
      <style>{`.workflow-canvas{overflow:auto;min-height:340px}.workflow-canvas svg{display:block;touch-action:none;user-select:none}.workflow-node{cursor:grab;touch-action:none}.workflow-node:active{cursor:grabbing}.workflow-node:focus{outline:2px solid currentColor}.workflow-port{cursor:crosshair;touch-action:none}`}</style>
      <div className="workflow-tools">
        <button
          className="secondary"
          aria-label={tr("缩小画布")}
          onClick={() => setZoom((value) => Math.max(0.3, value - 0.1))}
        >
          －
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button
          className="secondary"
          aria-label={tr("放大画布")}
          onClick={() => setZoom((value) => Math.min(2, value + 0.1))}
        >
          ＋
        </button>
        <button
          className="secondary"
          onClick={() =>
            setZoom(
              Math.max(
                0.3,
                Math.min(
                  1,
                  ((canvas.current?.clientWidth ?? width) - 36) / width,
                ),
              ),
            )
          }
        >
          {tr("适应画布")}
        </button>
      </div>
      <section
        ref={canvas}
        className="panel workflow-canvas"
        aria-label={tr("渠道流程画布")}
      >
        <svg
          ref={svgCanvas}
          width={width * zoom}
          height={height * zoom}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={tr("渠道功能连接图")}
          onPointerMove={movePointer}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
        >
          <defs>
            <marker
              id="flow-arrow"
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="3"
              orient="auto"
            >
              <path d="M0,0 L0,6 L7,3 z" fill="currentColor" />
            </marker>
          </defs>
          {flow.nodes.flatMap((node) =>
            outgoing(node).map((edge) => {
              const from = points.get(node.id)!;
              const to = points.get(edge.target);
              return to ? (
                <path
                  key={node.id + "-" + edge.field}
                  d={curve(from, to, edge.y)}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  opacity=".48"
                  markerEnd="url(#flow-arrow)"
                />
              ) : null;
            }),
          )}
          {linkingPath && (
            <path
              d={linkingPath}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeDasharray="6 4"
              opacity=".75"
              pointerEvents="none"
            />
          )}
          {flow.nodes.map((node) => {
            const point = points.get(node.id)!;
            return (
              <g
                key={node.id}
                className="workflow-node"
                role="button"
                tabIndex={0}
                aria-label={node.id + " " + workflowNodeLabels[node.type]}
                onClick={() => select(node.id)}
                onPointerDown={(event) =>
                  startMovingNode(event, node.id, point)
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    select(node.id);
                  }
                }}
              >
                <rect
                  x={point.x}
                  y={point.y}
                  width="170"
                  height="70"
                  rx="10"
                  fill="currentColor"
                  fillOpacity={node.id === selected ? ".14" : ".05"}
                  stroke="currentColor"
                  strokeOpacity={node.id === selected ? ".8" : ".2"}
                />
                {node.type !== "start" && (
                  <>
                    <circle
                      className="workflow-port"
                      data-input-node={node.id}
                      cx={point.x}
                      cy={point.y + 35}
                      r="10"
                      fill="transparent"
                    >
                      <title>{tr("连接到")}</title>
                    </circle>
                    <circle
                      className="workflow-port"
                      cx={point.x}
                      cy={point.y + 35}
                      r={linkTarget === node.id ? "6" : "5"}
                      fill={
                        linkTarget === node.id
                          ? "currentColor"
                          : "var(--panel, Canvas)"
                      }
                      stroke="currentColor"
                      strokeWidth="2"
                      pointerEvents="none"
                    />
                  </>
                )}
                <text
                  x={point.x + 12}
                  y={point.y + 27}
                  fill="currentColor"
                  fontSize="13"
                >
                  {workflowNodeLabels[node.type]}
                </text>
                <text
                  x={point.x + 12}
                  y={point.y + 48}
                  fill="currentColor"
                  opacity=".65"
                  fontSize="11"
                >
                  {node.type === "provider"
                    ? (node.upstream?.protocol ??
                      (personal
                        ? (channel?.protocol ?? tr("渠道上游"))
                        : tr("尚未配置上游")))
                    : node.type === "protocol"
                      ? node.allow.length +
                        tr(" 种入口 · ") +
                        (node.conversion === "auto"
                          ? tr("自动转换")
                          : tr("仅同协议"))
                      : node.type === "routing"
                        ? node.profile
                        : node.type === "upstream"
                          ? node.target
                          : node.type === "reasoning"
                            ? node.effort
                            : node.type === "rateLimit"
                              ? Object.entries(node.rule)
                                  .map(([key, value]) => value + " " + key)
                                  .join(" · ")
                              : node.type === "tps"
                                ? (node.rate ?? node.aggregateRate) + " token/s"
                                : node.type === "maxTokens"
                                  ? node.limit + " tokens"
                                  : node.id}
                </text>
                {outgoing(node).map((edge) => (
                  <g key={edge.field}>
                    {node.type === "condition" && (
                      <text
                        x={point.x + 154}
                        y={point.y + edge.y + 4}
                        textAnchor="end"
                        fill="currentColor"
                        opacity=".7"
                        fontSize="10"
                      >
                        {edge.label}
                      </text>
                    )}
                    <circle
                      className="workflow-port"
                      cx={point.x + 170}
                      cy={point.y + edge.y}
                      r="11"
                      fill="transparent"
                      onPointerDown={(event) =>
                        startLinking(event, node.id, edge.field)
                      }
                    />
                    <circle
                      className="workflow-port"
                      cx={point.x + 170}
                      cy={point.y + edge.y}
                      r="5"
                      fill="var(--panel, Canvas)"
                      stroke="currentColor"
                      strokeWidth="2"
                      pointerEvents="none"
                    />
                  </g>
                ))}
              </g>
            );
          })}
        </svg>
      </section>
    </div>
  );
}
