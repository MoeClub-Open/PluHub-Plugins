import React from "react";
import {
  Handle,
  Position,
  useInternalNode,
  useNodeConnections,
  useNodeId,
} from "@xyflow/react";
import type { WorkflowNode } from "@pluhub/contracts/workflow";
import type { UpstreamInterface } from "@pluhub/contracts/ai";
import {
  workflowParameters,
  type WorkflowValueType,
} from "../ai/workflow-parameters.js";
import { t as tr } from "./i18n.js";

export const FlowParameterContext = React.createContext<{
  personalInterfaces?: UpstreamInterface[];
  personal?: boolean;
  visibleFields?: ReadonlySet<string>;
}>({});

export const flowTypeColor: Record<WorkflowValueType, string> = {
  string: "#52aca6",
  number: "#87b95b",
  integer: "#87b95b",
  boolean: "#d17b98",
  "string[]": "#729ed0",
  object: "#a28dc5",
  json: "#a28dc5",
  secret: "#d1a34a",
};
export function flowTypeLabel(type: WorkflowValueType) {
  return tr(
    {
      string: "文本",
      number: "数字",
      integer: "整数",
      boolean: "布尔",
      "string[]": "文本列表",
      object: "对象",
      json: "JSON",
      secret: "密钥",
    }[type],
  );
}
export function FlowParameter({
  field,
  children,
  connectOnly = false,
}: {
  field: string;
  children: React.ReactNode;
  connectOnly?: boolean;
}) {
  const nodeId = useNodeId()!;
  const item = useInternalNode(nodeId)?.data.node as WorkflowNode | undefined;
  const { personalInterfaces, personal, visibleFields } =
    React.useContext(FlowParameterContext);
  const connections = useNodeConnections({
    id: nodeId,
    handleType: "target",
    handleId: "param:" + field,
  });
  const parameter =
    item &&
    workflowParameters(item, personalInterfaces, personal).find(
      (p) => p.path === field,
    );
  const row = React.useRef<HTMLDivElement>(null);
  const [offset, setOffset] = React.useState<number>();
  React.useLayoutEffect(() => {
    const element = row.current;
    const node = element?.closest<HTMLElement>(".flow-node");
    if (!element || !node) return;
    const measure = () => {
      const scale = node.getBoundingClientRect().width / node.offsetWidth;
      if (scale)
        setOffset(
          -Math.round(
            (element.getBoundingClientRect().left -
              node.getBoundingClientRect().left) /
              scale,
          ),
        );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    observer.observe(element);
    return () => observer.disconnect();
  }, [nodeId, field, parameter?.path]);
  if (!parameter) return <>{children}</>;
  const connected = connections.length > 0;
  const color = flowTypeColor[parameter.type];
  const label = flowTypeLabel(parameter.type);
  return (
    <div
      ref={row}
      className="flow-parameter"
      data-flow-parameter={field}
      style={{ "--flow-param-color": color } as React.CSSProperties}
    >
      {(!visibleFields || visibleFields.has(field)) && (
        <Handle
          type="target"
          position={Position.Left}
          id={"param:" + field}
          className="flow-parameter-handle"
          style={{ left: offset }}
          title={tr(parameter.label) + " · " + label}
        />
      )}
      <span
        className="flow-parameter-type"
        title={connected ? tr(connectOnly ? "已连接" : "已连接，断开后可编辑") : label}
      >
        {connected ? tr("已连接") + " · " : ""}
        {label}
      </span>
      <fieldset className="flow-parameter-fields" disabled={connected}>
        {children}
      </fieldset>
    </div>
  );
}
