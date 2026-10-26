import React from "react";
import type { Node, ReactFlowInstance } from "@xyflow/react";
import type { ChannelWorkflow } from "@pluhub/contracts/workflow";
import {
  copyFlowSelection,
  pasteFlowSelection,
} from "./channel-graph-operations.js";

export const isFlowTextInput = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  !!target.closest(
    "input, textarea, select, [contenteditable=true], [role=combobox], [role=listbox], [role=option]",
  );

export function useFlowClipboard<N extends Node>({
  flow,
  graph,
  disabled,
  update,
  select,
  pendingSelection,
  container,
}: {
  flow: ChannelWorkflow;
  graph: ReactFlowInstance<N>;
  disabled?: boolean;
  update: (flow: ChannelWorkflow) => void;
  select: (id: string) => void;
  pendingSelection: React.RefObject<string[] | undefined>;
  container: React.RefObject<HTMLDivElement | null>;
}) {
  const pointer = React.useRef<{ x: number; y: number } | undefined>(undefined);
  const pasteCount = React.useRef(0);
  const currentFlow = () => ({
    ...flow,
    layout: Object.fromEntries(
      graph.getNodes().map((node) => [node.id, node.position]),
    ),
  });
  const selectedIds = () =>
    graph
      .getNodes()
      .filter((node) => node.selected)
      .map((node) => node.id);
  function insert(
    selection: ReturnType<typeof copyFlowSelection>,
    position: { x: number; y: number },
  ) {
    if (disabled) return;
    const next = pasteFlowSelection(currentFlow(), selection, position);
    if (!next) return;
    pendingSelection.current = next.ids;
    update(next.flow);
    select(next.ids.at(-1)!);
  }
  function duplicate(ids = selectedIds()) {
    const selection = copyFlowSelection(currentFlow(), ids);
    if (!selection.nodes.length) return;
    const points = Object.values(selection.layout);
    insert(selection, {
      x: Math.min(...points.map((p) => p.x)) + 50,
      y: Math.min(...points.map((p) => p.y)) + 80,
    });
  }
  function copy(event: React.ClipboardEvent) {
    if (isFlowTextInput(event.target)) return false;
    const selection = copyFlowSelection(currentFlow(), selectedIds());
    if (!selection.nodes.length) return false;
    event.clipboardData.setData(
      "text/plain",
      JSON.stringify({ kind: "pluhub-flow", ...selection }),
    );
    event.preventDefault();
    return true;
  }
  return {
    duplicate,
    handlers: {
      onPointerMove: (event: React.PointerEvent) => {
        pointer.current = { x: event.clientX, y: event.clientY };
        pasteCount.current = 0;
      },
      onCopy: copy,
      onCut: (event: React.ClipboardEvent) => {
        if (!disabled && copy(event))
          void graph.deleteElements({
            nodes: graph
              .getNodes()
              .filter((node) => node.selected && node.id !== flow.entry),
          });
      },
      onPaste: (event: React.ClipboardEvent) => {
        if (disabled || isFlowTextInput(event.target)) return;
        try {
          const data = JSON.parse(event.clipboardData.getData("text/plain"));
          if (
            data.kind !== "pluhub-flow" ||
            !Array.isArray(data.nodes) ||
            !data.layout ||
            data.nodes.some((node: Node) => node.type === "start")
          )
            return;
          const bounds = container.current!.getBoundingClientRect();
          const position = graph.screenToFlowPosition(
            pointer.current ?? {
              x: bounds.x + bounds.width / 2,
              y: bounds.y + bounds.height / 2,
            },
          );
          const offset = pasteCount.current++ * 40;
          insert(data, { x: position.x + offset, y: position.y + offset });
          event.preventDefault();
        } catch {
          // Ordinary text and unrelated clipboard formats stay with the browser.
        }
      },
      onKeyDown: (event: React.KeyboardEvent) => {
        if (isFlowTextInput(event.target)) return;
        const key = event.key.toLowerCase();
        if ((event.ctrlKey || event.metaKey) && key === "a") {
          event.preventDefault();
          graph.setNodes((nodes) =>
            nodes.map((node) => ({ ...node, selected: true })),
          );
          graph.setEdges((edges) =>
            edges.map((edge) => ({ ...edge, selected: false })),
          );
        } else if (
          !disabled &&
          (event.ctrlKey || event.metaKey) &&
          key === "d"
        ) {
          event.preventDefault();
          duplicate();
        } else if (event.key === "Escape") {
          graph.setNodes((nodes) =>
            nodes.map((node) => ({ ...node, selected: false })),
          );
          graph.setEdges((edges) =>
            edges.map((edge) => ({ ...edge, selected: false })),
          );
          select("");
        }
      },
    },
  };
}
