import type { ChannelWorkflow } from "@pluhub/contracts/workflow";

/** Preserve the association with an interface rule when rules are moved or removed. */
export function remapWorkflowInterfaces(
  flow: ChannelWorkflow,
  targetId: string,
  personal: boolean,
  remap: readonly number[],
): ChannelWorkflow {
  if (!flow.bindings?.length) return flow;
  const prefix = personal ? "interfaces." : "upstream.interfaces.";
  const targets = personal
    ? new Set(
        flow.nodes
          .filter((node) => node.type === "provider")
          .map((node) => node.id),
      )
    : new Set([targetId]);
  return {
    ...flow,
    bindings: flow.bindings.flatMap((binding) => {
      if (!targets.has(binding.target) || !binding.input.startsWith(prefix))
        return [binding];
      const match = /^(\d+)(\..+)$/.exec(binding.input.slice(prefix.length));
      if (!match) return [binding];
      const index = remap[Number(match[1])];
      return index === undefined || index < 0
        ? []
        : [{ ...binding, input: prefix + index + match[2] }];
    }),
  };
}
