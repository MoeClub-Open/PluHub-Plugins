import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import type { ModelRoute, Upstream } from "@pluhub/contracts/ai";
import { channelProviderNodes } from "../../lib/ai/channel-config.js";
import { Checkbox } from "../../lib/ui/checkbox.js";
import { Select } from "../../lib/ui/select.js";
import { Dialog, Empty, Icon } from "../../lib/ui/components.js";
import { t as tr } from "../../lib/ui/i18n.js";
import { Notice } from "../../lib/ui/mount.js";

export type ChannelModel = {
  id: string;
  name?: string;
  contextLength?: number;
  maxOutputTokens?: number;
  protocols: string[];
};
type ModelsResponse = {
  nodeId: string;
  models: ChannelModel[];
  errors: { protocol: string; message: string }[];
};

export function ChannelModels({
  host,
  channelId,
  upstreams,
  models,
  initialNodeId,
  add,
  edit,
  create,
  remove,
  toggle,
  close,
}: {
  host: UIHost;
  channelId: string;
  upstreams: Record<string, Upstream>;
  models: Record<string, ModelRoute>;
  initialNodeId?: string;
  add: (id: string, models: ChannelModel[], nodeId: string) => Promise<void>;
  edit: (id: string, nodeId?: string) => void;
  create: (channelId: string, model?: ChannelModel, nodeId?: string) => void;
  remove: (id: string) => Promise<void>;
  toggle: (id: string, enabled: boolean) => Promise<void>;
  close: () => void;
}) {
  const nodes = channelProviderNodes(upstreams[channelId]!);
  const [nodeId, setNodeId] = React.useState(
    nodes.some((node) => node.id === initialNodeId)
      ? initialNodeId!
      : nodes.length === 1
        ? nodes[0]!.id
        : "",
  );
  const [tab, setTab] = React.useState("provided");
  const [query, setQuery] = React.useState("");
  const [data, setData] = React.useState<ModelsResponse>();
  const [selected, setSelected] = React.useState<string[]>([]);
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const node = nodes.find((item) => item.id === nodeId)?.node;
  const routes = Object.entries(models).filter(
    ([, route]) => route.upstream === channelId,
  );
  const matches = (...values: string[]) =>
    values.join(" ").toLowerCase().includes(query.trim().toLowerCase());
  const directory = (data?.models ?? []).filter((model) =>
    matches(model.id, model.name ?? ""),
  );
  async function discover() {
    setBusy(true);
    setMessage("");
    setSelected([]);
    try {
      setData(
        await host.request<ModelsResponse>(
          "/api/plugins/official.ai-router/channel-models",
          {
            method: "POST",
            body: JSON.stringify({ id: channelId, nodeId }),
          },
        ),
      );
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await action();
      setSelected([]);
      setTab("provided");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={tr("提供模型") + " · " + (upstreams[channelId]?.name || channelId)}
      close={() => {
        if (!busy) close();
      }}
    >
      <Notice
        message={
          message ||
          data?.errors.map((error) => tr(error.message)).join(" · ") ||
          ""
        }
      />
      <div className="tabs" role="tablist" aria-label={tr("提供模型")}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "provided"}
          className={tab === "provided" ? "active" : ""}
          onClick={() => setTab("provided")}
        >
          {tr("提供模型")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "import"}
          className={tab === "import" ? "active" : ""}
          onClick={() => setTab("import")}
        >
          {tr("从上游导入")}
        </button>
      </div>
      <div className="data-toolbar">
        {!!nodes.length && (
          <Select
            aria-label={tr("上游节点")}
            value={nodeId}
            disabled={busy}
            onChange={(event) => {
              setNodeId(event.target.value);
              setData(undefined);
              setSelected([]);
            }}
          >
            <option value="">{tr("选择上游节点")}</option>
            {nodes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id} · {item.connection.protocol}
              </option>
            ))}
          </Select>
        )}
        <input
          type="search"
          aria-label={tr("搜索渠道模型")}
          placeholder={tr("搜索模型 ID 或名称")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {tab === "provided" ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => create(channelId, undefined, nodeId || undefined)}
          >
            <Icon name="plus" size={15} />
            {tr("添加模型")}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy || !nodeId}
            onClick={() => void discover()}
          >
            <Icon name="refresh" size={15} />
            {tr("获取模型")}
          </button>
        )}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {tab === "import" && (
                <th className="selection-cell">
                  <Checkbox
                    aria-label={tr("选择全部可用模型")}
                    checked={
                      !!directory.length &&
                      directory.every((model) => selected.includes(model.id))
                    }
                    onCheckedChange={(checked) =>
                      setSelected(
                        checked ? directory.map((model) => model.id) : [],
                      )
                    }
                  />
                </th>
              )}
              <th>{tr("模型")}</th>
              {tab === "provided" && (
                <>
                  <th>{tr("上游模型 ID")}</th>
                  <th>{tr("状态")}</th>
                  <th>{tr("操作")}</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {tab === "provided"
              ? routes
                  .filter(([id, route]) =>
                    matches(
                      id,
                      route.publicModel ?? "",
                      route.model,
                      route.name ?? "",
                    ),
                  )
                  .map(([id, route]) => (
                    <tr key={id}>
                      <td>
                        <strong>{route.publicModel ?? id}</strong>
                        {route.name && <small>{route.name}</small>}
                      </td>
                      <td>
                        {node
                          ? node.modelMap
                            ? (node.modelMap[route.model] ?? tr("未映射"))
                            : (node.model ?? route.model)
                          : "—"}
                      </td>
                      <td>
                        <Checkbox
                          appearance="switch"
                          aria-label={tr("启用模型")}
                          checked={route.enabled !== false}
                          disabled={busy}
                          onCheckedChange={(checked) =>
                            void perform(() => toggle(id, checked === true))
                          }
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="ghost"
                          disabled={busy}
                          onClick={() => edit(id, nodeId || undefined)}
                        >
                          {tr("编辑")}
                        </button>
                        <button
                          type="button"
                          className="ghost danger"
                          disabled={busy}
                          onClick={() => void perform(() => remove(id))}
                        >
                          {tr("删除")}
                        </button>
                      </td>
                    </tr>
                  ))
              : directory.map((model) => (
                  <tr key={model.id}>
                    <td className="selection-cell">
                      <Checkbox
                        aria-label={tr("选择模型 {0}", { "0": model.id })}
                        checked={selected.includes(model.id)}
                        disabled={busy}
                        onCheckedChange={(checked) =>
                          setSelected((current) =>
                            checked
                              ? [...current, model.id]
                              : current.filter((id) => id !== model.id),
                          )
                        }
                      />
                    </td>
                    <td>
                      <strong>{model.id}</strong>
                      {model.name !== model.id && <small>{model.name}</small>}
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
      {(tab === "provided" ? !routes.length : !directory.length) && (
        <Empty title={tr("暂无模型")} />
      )}
      {tab === "import" && (
        <div className="actions">
          <button
            type="button"
            disabled={busy || !selected.length}
            onClick={() =>
              void perform(() =>
                add(
                  channelId,
                  (data?.models ?? []).filter((model) =>
                    selected.includes(model.id),
                  ),
                  nodeId,
                ),
              )
            }
          >
            {tr("添加所选模型")}
          </button>
        </div>
      )}
    </Dialog>
  );
}
