import { Groups } from "./groups-ui.js";
import { t as tr, textValue } from "../../lib/ui/i18n.js";
import React from "react";
import { Select } from "../../lib/ui/select.js";
import type { UIHost } from "@pluhub/ui-sdk";
import type {
  Upstream,
  ModelRoute,
  ServiceGroup,
} from "@pluhub/contracts/ai";
import { ChannelTable } from "./channel-table.js";
import { ChannelModels, type ChannelModel } from "./channel-models.js";
import { ModelEditor } from "./model-editor.js";
import {
  availableModelId,
  discoveredModelRoute,
  assignProviderModel,
} from "./model-config.js";
import { ChannelGraphEditor } from "../../lib/ui/channel-graph-editor.js";
import { channelEditorTarget } from "../../lib/ui/channel-location.js";
import { defaultChannelFlow } from "../../lib/ai/channel-config.js";
import { setChannelState } from "../../lib/ai/channel-list.js";
import { mountPage, useLoad, Notice } from "../../lib/ui/mount.js";
import { PageHeading, Icon, Empty, Dialog } from "../../lib/ui/components.js";
type Router = {
  upstreams: Record<string, Upstream>;
  models: Record<string, ModelRoute>;
  nextChannelId?: string;
  groups?: Record<string, ServiceGroup>;
};
function Page({ host }: { host: UIHost }) {
  const loaded = useLoad<any>(() =>
    host.request("/api/plugins/official.ai-router/configuration"),
  );
  const [page, setPage] = React.useState(location.hash);
  const requestedTab = new URLSearchParams(page.split("?")[1]).get("tab");
  const [tab, setTab] = React.useState(
    requestedTab === "groups" ||
      requestedTab === "models" ||
      requestedTab === "advanced"
      ? requestedTab
      : "channels",
  );
  React.useEffect(() => {
    const change = () => {
      setPage(location.hash);
    };
    addEventListener("hashchange", change);
    return () => removeEventListener("hashchange", change);
  }, []);
  const [dialog, setDialog] = React.useState<{
    id: string;
  }>();
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [testing, setTesting] = React.useState("");
  const [tests, setTests] = React.useState<Record<string, string>>({});
  const [advanced, setAdvanced] = React.useState("");
  const [modelChannel, setModelChannel] = React.useState("");
  const [modelNodeId, setModelNodeId] = React.useState("");
  const [modelQuery, setModelQuery] = React.useState("");
  const [modelUpstream, setModelUpstream] = React.useState("");
  const [modelDialog, setModelDialog] = React.useState<{
    id?: string;
    suggestedId: string;
    model: ModelRoute;
    mode: "offer" | "price";
    nodeId?: string;
  }>();
  const router: Router = loaded.data?.config ?? { upstreams: {}, models: {} };
  const upstreams = router.upstreams ?? {};
  const models = router.models ?? {};
  const filteredModels = Object.entries(models).filter(
    ([id, model]) =>
      (!modelUpstream || model.upstream === modelUpstream) &&
      [id, model.model, model.name, upstreams[model.upstream]?.name]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(modelQuery.trim().toLowerCase()),
  );
  const graph = channelEditorTarget(page, upstreams);
  const openGraph = (id: string) =>
    host.navigate("/channels?channel=" + encodeURIComponent(id));
  React.useEffect(() => {
    setAdvanced(JSON.stringify(router, null, 2));
  }, [loaded.data]);
  async function save(update: (r: Router) => void) {
    setBusy(true);
    setMessage("");
    try {
      if (!loaded.data) throw new Error(tr("渠道插件配置不存在"));
      const next: Router = structuredClone(router);
      next.upstreams ??= {};
      next.models ??= {};
      update(next);
      await host.request("/api/plugins/official.ai-router/configuration", {
        method: "PUT",
        body: JSON.stringify({ config: next, revision: loaded.data.revision }),
      });
      setMessage(tr("已保存"));
      setDialog(undefined);
      loaded.reload();
    } catch (e) {
      setMessage((e as Error).message);
      throw e;
    } finally {
      setBusy(false);
    }
  }
  const mutate = (fn: (r: Router) => void) => {
    void save(fn).catch(() => {});
  };
  async function addChannelModels(
    id: string,
    picked: ChannelModel[],
    nodeId: string,
  ) {
    await save((r) => {
      if (!r.upstreams[id]) throw new Error(tr("渠道已被删除，请刷新。"));
      for (const model of picked) {
        const existing = Object.values(r.models).find(
          (route) => route.upstream === id && route.model === model.id,
        );
        assignProviderModel(
          r,
          id,
          nodeId,
          existing?.model ?? model.id,
          model.id,
        );
        if (existing) continue;
        const alias = availableModelId(
          Object.keys(r.models),
          id,
          model.id,
        );
        r.models[alias] = discoveredModelRoute(id, model);
      }
    });
  }
  function createModel(
    channelId: string,
    model?: ChannelModel,
    nodeId?: string,
  ) {
    setModelDialog({
      mode: "offer",
      nodeId,
      suggestedId: model
        ? availableModelId(
            Object.keys(models),
            channelId,
            model.id,
          )
        : "",
      model: model
        ? discoveredModelRoute(channelId, model)
        : { upstream: channelId, model: "", enabled: true },
    });
  }
  function editModel(
    id: string,
    nodeId?: string,
    mode: "offer" | "price" = "offer",
  ) {
    if (models[id])
      setModelDialog({ id, suggestedId: id, model: models[id], mode, nodeId });
  }
  async function test(id: string) {
    const mapping = Object.entries(models).find(([, m]) => m.upstream === id);
    if (!mapping) {
      setMessage(tr("请先为该渠道添加一个模型映射，再发送测试请求。"));
      return;
    }
    setTesting(id);
    setMessage("");
    try {
      const result = await host.request<any>(
        "/api/plugins/official.ai-router/test",
        {
          method: "POST",
          body: JSON.stringify({ upstream: id, publicModel: mapping[0] }),
        },
      );
      setTests((t) => ({
        ...t,
        [id]: tr("测试通过 · ") + result.latencyMs + " ms",
      }));
    } catch (e) {
      setTests((t) => ({ ...t, [id]: tr("测试失败") }));
      setMessage((e as Error).message);
    } finally {
      setTesting("");
    }
  }
  const existing = dialog ? upstreams[dialog.id] : undefined;
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (key: string) => String(f.get(key) ?? "").trim();
    if (!dialog) return;
    let id = dialog.id;
    try {
      await save((r) => {
        if (!dialog.id) {
          let next = BigInt(r.nextChannelId ?? "1");
          for (const current of Object.keys(r.upstreams)) {
            if (!/^\d+$/.test(current)) continue;
            const candidate = BigInt(current) + 1n;
            if (candidate > next) next = candidate;
          }
          id = String(next);
          r.nextChannelId = String(next + 1n);
        }
        if (!dialog.id && Object.hasOwn(r.upstreams, id))
          throw new Error(tr("该 ID 已存在，请使用不同的 ID。"));
        r.upstreams[id] = {
          ...(existing ?? {}),
          name: text("name"),
          enabled: existing ? existing.enabled !== false : false,
          flow: existing?.flow ?? defaultChannelFlow(),
          consumptionMultiplier: Number(text("consumptionMultiplier") || 1),
          priority: Number(text("priority") || 0),
        };
      });
      openGraph(id);
    } catch {}
  }
  const modelDialogs = (
    <>
      {modelChannel && (
        <ChannelModels
          host={host}
          channelId={modelChannel}
          upstreams={upstreams}
          models={models}
          initialNodeId={modelNodeId}
          add={addChannelModels}
          edit={editModel}
          create={createModel}
          toggle={(id, enabled) =>
            save((r) => {
              r.models[id]!.enabled = enabled;
            })
          }
          remove={(id) =>
            save((r) => {
              const removed = r.models[id]!;
              delete r.models[id];
              if (
                !Object.values(r.models).some(
                  (route) =>
                    route.upstream === removed.upstream &&
                    route.model === removed.model,
                )
              )
                for (const node of r.upstreams[removed.upstream]?.flow?.nodes ??
                  [])
                  if (node.type === "provider" && node.modelMap)
                    delete node.modelMap[removed.model];
            })
          }
          close={() => {
            if (!busy) setModelChannel("");
          }}
        />
      )}
      {modelDialog && (
        <ModelEditor
          key={
            modelDialog.id ||
            modelDialog.model.upstream + ":" + modelDialog.model.model
          }
          {...modelDialog}
          upstreams={upstreams}
          providerModel={
            modelDialog.nodeId
              ? (() => {
                  const node = upstreams[
                    modelDialog.model.upstream
                  ]?.flow?.nodes.find((item) => item.id === modelDialog.nodeId);
                  return node?.type === "provider"
                    ? node.modelMap
                      ? (node.modelMap[modelDialog.model.model] ?? "")
                      : (node.model ?? modelDialog.model.model)
                    : "";
                })()
              : undefined
          }
          save={(id, model, providerModel) =>
            save((r) => {
              const alias =
                id ||
                availableModelId(
                  Object.keys(r.models),
                  model.upstream,
                  model.model,
                );
              if (
                !modelDialog.id &&
                Object.hasOwn(r.models, alias)
              )
                throw new Error(tr("该 ID 已存在，请使用不同的 ID。"));
              if (modelDialog.id && !r.models[modelDialog.id])
                throw new Error(tr("模型已被删除，请刷新。"));
              if (!r.upstreams[model.upstream])
                throw new Error(tr("渠道已被删除，请刷新。"));
              if (modelDialog.nodeId && providerModel !== undefined)
                assignProviderModel(
                  r,
                  model.upstream,
                  modelDialog.nodeId,
                  model.model,
                  providerModel,
                );
              r.models[alias] = model;
            })
          }
          close={() => setModelDialog(undefined)}
        />
      )}
    </>
  );
  if (host.page === "/settings/service-groups" || requestedTab === "groups")
    return (
      <>
        <PageHeading title={tr("使用分组")} />
        <Notice message={message || loaded.error} />
        {loaded.data && (
          <Groups
            host={host}
            groups={router.groups}
            upstreams={upstreams}
            save={save}
            busy={busy}
          />
        )}
      </>
    );
  if (graph)
    return (
      <>
        {modelDialogs}
        <ChannelGraphEditor
          host={host}
          key={graph.channelId}
          channelId={graph.channelId}
          configurationRevision={loaded.data?.revision}
          initialPanel={graph.panel}
          close={() => {
            host.navigate("/channels");
            loaded.reload();
          }}
          saved={() => loaded.reload()}
          manageModels={(nodeId) => {
            setModelNodeId(nodeId ?? "");
            setModelChannel(graph.channelId);
          }}
        />
      </>
    );
  return (
    <>
      <PageHeading title={tr("渠道")}>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => loaded.reload()}
        >
          <Icon name="refresh" size={15} />
          {tr("刷新")}
        </button>
        {tab === "channels" && (
          <button
            disabled={!loaded.data || busy}
            onClick={() => setDialog({ id: "" })}
          >
            <Icon name="plus" size={16} />
            {tr("添加渠道")}
          </button>
        )}
      </PageHeading>
      <Notice message={message || loaded.error} />
      <div className="tabs" role="tablist" aria-label={tr("渠道配置")}>
        <button
          role="tab"
          aria-selected={tab === "channels"}
          className={tab === "channels" ? "active" : ""}
          onClick={() => setTab("channels")}
        >
          {tr("渠道 {0}", { "0": textValue(Object.keys(upstreams).length) })}
        </button>
        <button
          role="tab"
          aria-selected={tab === "models"}
          className={tab === "models" ? "active" : ""}
          onClick={() => setTab("models")}
        >
          {tr("模型定价")} {textValue(Object.keys(models).length)}
        </button>
        <button
          role="tab"
          aria-selected={tab === "advanced"}
          className={tab === "advanced" ? "active" : ""}
          onClick={() => setTab("advanced")}
        >
          {tr("高级 JSON")}
        </button>
      </div>
      {tab === "channels" &&
        (Object.keys(upstreams).length ? (
          <ChannelTable
            upstreams={upstreams}
            models={models}
            busy={busy}
            testing={testing}
            tests={tests}
            edit={(id) => setDialog({ id })}
            graph={openGraph}
            toggle={(id, enabled) =>
              mutate((r) => setChannelState(r.upstreams, [id], enabled))
            }
            test={(id) => void test(id)}
            modelsFor={(id) => {
              setModelUpstream(id);
              setTab("models");
            }}
            remove={(id) =>
              mutate((r) => {
                if (
                  Object.values(r.models).some((model) => model.upstream === id)
                )
                  throw new Error(tr("请先移除引用此渠道的模型映射。"));
                delete r.upstreams[id];
              })
            }
            batch={(ids, enabled) =>
              save((r) => setChannelState(r.upstreams, ids, enabled))
            }
          />
        ) : (
          <Empty title={tr("暂无渠道")} />
        ))}
      {tab === "models" && (
        <div className="data-toolbar" role="search">
          <label className="data-search">
            <Icon name="search" size={17} />
            <input
              type="search"
              aria-label={tr("搜索渠道模型")}
              placeholder={tr("搜索模型 ID 或名称")}
              value={modelQuery}
              onChange={(event) => setModelQuery(event.target.value)}
            />
          </label>
          <Select
            aria-label={tr("渠道")}
            value={modelUpstream}
            onChange={(event) => setModelUpstream(event.target.value)}
          >
            <option value="">{tr("全部渠道")}</option>
            {Object.entries(upstreams).map(([id, upstream]) => (
              <option key={id} value={id}>
                {upstream.name || id}
              </option>
            ))}
          </Select>
        </div>
      )}
      {tab === "models" &&
        (filteredModels.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{tr("公开模型 / 名称")}</th>
                  <th>{tr("渠道")}</th>
                  <th>{tr("原价 · USD")}</th>
                  <th>{tr("渠道消耗倍率")}</th>
                  <th>{tr("状态")}</th>
                  <th>{tr("操作")}</th>
                </tr>
              </thead>
              <tbody>
                {filteredModels.map(([id, m]) => (
                  <tr key={id}>
                    <td>
                      <strong>{m.name || m.publicModel || id}</strong>
                      {(m.name || m.publicModel || id) !==
                        (m.publicModel ?? id) && (
                        <small>{m.publicModel ?? id}</small>
                      )}
                    </td>
                    <td>{upstreams[m.upstream]?.name || m.upstream}</td>
                    <td>
                      {m.pricing?.mode === "expression" ? (
                        tr("动态定价")
                      ) : m.pricing?.mode === "request" ? (
                        "$" + m.pricing.request + " / " + tr("次")
                      ) : (
                        <>
                          {m.inputPrice ?? "—"} / {m.outputPrice ?? "—"}
                          <small>
                            {tr("输入 / 输出价格")} · {tr("USD / 百万 Token")}
                          </small>
                        </>
                      )}
                    </td>
                    <td>
                      ×{upstreams[m.upstream]?.consumptionMultiplier ?? 1}
                    </td>
                    <td>
                      <span
                        className={
                          "badge " +
                          (m.enabled !== false &&
                          upstreams[m.upstream]?.enabled !== false
                            ? "ready"
                            : "")
                        }
                      >
                        {m.enabled === false ||
                        upstreams[m.upstream]?.enabled === false
                          ? tr("已停用")
                          : tr("已启用")}
                      </span>
                    </td>
                    <td>
                      <button
                        className="ghost"
                        onClick={() => editModel(id, undefined, "price")}
                      >
                        {tr("定价")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title={tr(
              modelQuery || modelUpstream ? "没有匹配的模型" : "暂无模型映射",
            )}
          />
        ))}
      {tab === "advanced" && (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              const next = JSON.parse(advanced);
              if (!next || typeof next !== "object" || Array.isArray(next))
                throw new Error(tr("配置必须是 JSON 对象。"));
              mutate((r) => {
                for (const k of Object.keys(r)) delete (r as any)[k];
                Object.assign(r, next);
              });
            } catch (e) {
              setMessage((e as Error).message);
            }
          }}
        >
          <h2>{tr("高级渠道配置")}</h2>

          <textarea
            className="code"
            aria-label={tr("渠道配置")}
            rows={19}
            value={advanced}
            onChange={(e) => setAdvanced(e.target.value)}
          />
          <p>
            <button disabled={busy || !loaded.data}>{tr("保存并应用")}</button>
          </p>
        </form>
      )}

      {modelDialogs}

      {dialog && (
        <Dialog
          title={dialog.id ? tr("编辑渠道") : tr("添加渠道")}
          close={() => {
            if (!busy) setDialog(undefined);
          }}
        >
          <form onSubmit={submit} key={dialog.id}>
            <Notice message={message} />
            <div className="form-grid">
              <label className="full">
                {tr("显示名称")}
                <input
                  name="name"
                  defaultValue={existing?.name ?? ""}
                  maxLength={128}
                  placeholder={tr("便于识别的名称（可选）")}
                />
              </label>
              <label>
                {tr("优先级")}
                <input
                  name="priority"
                  type="number"
                  min="-1000000"
                  max="1000000"
                  step="1"
                  defaultValue={existing?.priority ?? 0}
                  required
                />
              </label>
              <label>
                {tr("渠道消耗倍率")}
                <input
                  name="consumptionMultiplier"
                  type="number"
                  min="0"
                  max="1000"
                  step="any"
                  defaultValue={existing?.consumptionMultiplier ?? 1}
                  required
                />
              </label>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setDialog(undefined)}
              >
                {tr("取消")}
              </button>
              <button disabled={busy}>
                {busy ? tr("保存中…") : tr("保存并编辑流程")}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
}
export const mount = (element: HTMLElement, host: UIHost) =>
  mountPage(element, host, Page);
