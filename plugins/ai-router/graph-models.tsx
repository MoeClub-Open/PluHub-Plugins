import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import type { ModelRoute, Upstream } from "@pluhub/contracts/ai";
import type { GraphModelsProps } from "../../lib/ui/channel-graph-editor.js";
import { channelProviderNodes } from "../../lib/ai/channel-config.js";
import { ChannelModels, type ChannelModel } from "./channel-models.js";
import { ModelEditor } from "./model-editor.js";
import {
  availableModelId,
  discoveredModelRoute,
  assignProviderModel,
} from "./model-config.js";

/** Model declarations and provider targets share the graph draft and its save/undo history. */
export function GraphModels({
  host,
  channelId,
  channel,
  flow,
  models,
  nodeId,
  update,
  close,
  reservedIds,
}: GraphModelsProps & {
  host: UIHost;
  channelId: string;
  channel: Upstream;
  reservedIds: string[];
}) {
  const [editing, setEditing] = React.useState<{
    id?: string;
    suggestedId: string;
    model: ModelRoute;
    nodeId?: string;
  }>();
  const config = () => ({
    upstreams: { [channelId]: { ...channel, flow: structuredClone(flow) } },
    models: structuredClone(models),
  });
  function commit(next: ReturnType<typeof config>) {
    update(next.upstreams[channelId]!.flow!, next.models);
  }
  const nodes = channelProviderNodes({ ...channel, flow });
  const usedIds = [...new Set([...reservedIds, ...Object.keys(models)])];
  const provider = nodes.find((item) => item.id === editing?.nodeId);
  return (
    <>
      <ChannelModels
        host={host}
        channelId={channelId}
        upstreams={{ [channelId]: { ...channel, flow } }}
        models={models}
        initialNodeId={nodeId}
        close={close}
        add={async (_id, picked, selectedNode) => {
          const next = config();
          for (const model of picked) {
            const existing = Object.values(next.models).find(
              (route) => route.model === model.id,
            );
            assignProviderModel(
              next,
              channelId,
              selectedNode,
              existing?.model ?? model.id,
              model.id,
            );
            if (!existing)
              next.models[
                availableModelId(
                  [...reservedIds, ...Object.keys(next.models)],
                  channelId,
                  model.id,
                )
              ] = discoveredModelRoute(channelId, model);
          }
          commit(next);
        }}
        create={(_id, model?: ChannelModel, selectedNode?: string) =>
          setEditing({
            suggestedId: model
              ? availableModelId(usedIds, channelId, model.id)
              : "",
            model: model
              ? discoveredModelRoute(channelId, model)
              : { upstream: channelId, model: "", enabled: true },
            nodeId: selectedNode,
          })
        }
        edit={(id, selectedNode) =>
          setEditing({
            id,
            suggestedId: id,
            model: models[id]!,
            nodeId: selectedNode,
          })
        }
        toggle={async (id, enabled) => {
          const next = config();
          next.models[id]!.enabled = enabled;
          commit(next);
        }}
        remove={async (id) => {
          const next = config(),
            removed = next.models[id]!;
          delete next.models[id];
          if (
            !Object.values(next.models).some(
              (route) => route.model === removed.model,
            )
          )
            for (const node of next.upstreams[channelId]!.flow!.nodes)
              if (node.type === "provider" && node.modelMap)
                delete node.modelMap[removed.model];
          commit(next);
        }}
      />
      {editing && (
        <ModelEditor
          host={host}
          {...editing}
          mode="offer"
          upstreams={{ [channelId]: { ...channel, flow } }}
          provider={
            provider
              ? {
                  id: provider.id,
                  catalogOnly: !!provider.connection.subscriptionAccountIds,
                  connection: provider.connection,
                }
              : undefined
          }
          providerModel={
            provider
              ? (provider.node.modelMap?.[editing.model.model] ??
                provider.node.model ??
                "")
              : undefined
          }
          save={async (id, model, target) => {
            const next = config();
            const alias =
              id ||
              availableModelId(
                [...reservedIds, ...Object.keys(next.models)],
                channelId,
                model.model,
              );
            if (editing.nodeId && target !== undefined)
              assignProviderModel(
                next,
                channelId,
                editing.nodeId,
                model.model,
                target,
              );
            next.models[alias] = model;
            commit(next);
          }}
          close={() => setEditing(undefined)}
        />
      )}
    </>
  );
}
