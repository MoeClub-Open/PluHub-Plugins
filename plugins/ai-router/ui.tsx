import { t as tr, textValue } from "../../lib/ui/i18n.js";
import { Select } from "../../lib/ui/select.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import type { Upstream, ModelRoute, ModelRedirect } from "@pluhub/contracts/ai";
import { Redirects } from "./redirect-ui.js";
import { ChannelTable } from "./channel-table.js";
import {
  ModelPriceFields,
  readModelPricing,
} from "../../lib/ui/model-pricing.js";
import { ChannelGraphEditor } from "../../lib/ui/channel-graph-editor.js";
import { channelEditorTarget } from "../../lib/ui/channel-location.js";
import {
  defaultChannelFlow,
  migrateLegacyChannels,
} from "../../lib/ai/channel-config.js";
import {
  setChannelState,
  syncChannelSecrets,
} from "../../lib/ai/channel-list.js";
import { mountPage, useLoad, Notice } from "../../lib/ui/mount.js";
import { PageHeading, Icon, Empty, Dialog } from "../../lib/ui/components.js";
const protocols = [
  "openai-chat",
  "openai-responses",
  "anthropic",
  "gemini",
  "codex",
  "claude-subscription",
  "antigravity",
  "auto-router",
];
const routerIndex = (config: any) =>
  config.plugins.findIndex((p: any) =>
    /\/(?:official\.)?ai-router$/.test(p.path.replace(/\\/g, "/")),
  );
type Router = {
  upstreams: Record<string, Upstream>;
  models: Record<string, ModelRoute>;
  redirects?: Record<string, ModelRedirect>;
  nextChannelId?: string;
};
function Page({ host }: { host: UIHost }) {
  const loaded = useLoad<any>(() => host.request("/api/host/config"));
  const [page, setPage] = React.useState(location.hash);
  const requestedTab = new URLSearchParams(page.split("?")[1]).get("tab");
  const [tab, setTab] = React.useState(
    requestedTab === "models" ||
      requestedTab === "redirects" ||
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
    type: "channel" | "model";
    id: string;
  }>();
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [testing, setTesting] = React.useState("");
  const [tests, setTests] = React.useState<Record<string, string>>({});
  const [advanced, setAdvanced] = React.useState("");
  const normalized = React.useMemo(() => {
    if (!loaded.data) return undefined;
    const copy = structuredClone(loaded.data);
    try {
      migrateLegacyChannels(copy);
    } catch {
      /* Preserve legacy settings for repair. */
    }
    return copy;
  }, [loaded.data]);
  const index = normalized ? routerIndex(normalized) : -1;
  const router: Router =
    index >= 0
      ? normalized.plugins[index].config
      : { upstreams: {}, models: {} };
  const upstreams = router.upstreams ?? {};
  const models = router.models ?? {};
  const graph = channelEditorTarget(page, upstreams);
  const openGraph = (id: string) =>
    host.navigate("/ai-router?channel=" + encodeURIComponent(id));
  React.useEffect(() => {
    setAdvanced(JSON.stringify(router, null, 2));
  }, [loaded.data]);
  async function save(update: (r: Router) => void) {
    setBusy(true);
    setMessage("");
    try {
      const config: any = await host.request("/api/host/config");
      migrateLegacyChannels(config);
      const i = routerIndex(config);
      if (i < 0) throw new Error(tr("AI Router 插件配置不存在"));
      const next = config.plugins[i].config;
      next.upstreams ??= {};
      next.models ??= {};
      const previous = structuredClone(next.upstreams);
      update(next);
      syncChannelSecrets(config.plugins, previous, next.upstreams, protocols);
      await host.request("/api/host/config", {
        method: "PUT",
        body: JSON.stringify(config),
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
  const existing: any =
    dialog?.type === "channel"
      ? upstreams[dialog.id]
      : dialog?.type === "model"
        ? models[dialog.id]
        : undefined;
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (key: string) => String(f.get(key) ?? "").trim();
    let id = dialog?.id || text("id");
    try {
      await save((r) => {
        if (dialog?.type === "channel" && !dialog.id) {
          let next = BigInt(r.nextChannelId ?? "1");
          for (const current of Object.keys(r.upstreams)) {
            if (!/^\d+$/.test(current)) continue;
            const candidate = BigInt(current) + 1n;
            if (candidate > next) next = candidate;
          }
          id = String(next);
          r.nextChannelId = String(next + 1n);
        }
        const collection = dialog?.type === "channel" ? r.upstreams : r.models;
        if (!dialog?.id && Object.hasOwn(collection, id))
          throw new Error(tr("该 ID 已存在，请使用不同的 ID。"));
        if (dialog?.type === "channel") {
          r.upstreams[id] = {
            ...(existing ?? {}),
            name: text("name"),
            enabled: existing ? existing.enabled !== false : false,
            flow: existing?.flow ?? defaultChannelFlow(),
            consumptionMultiplier: Number(text("consumptionMultiplier") || 1),
          };
        } else {
          const m: ModelRoute = {
            ...(existing ?? {}),
            upstream: text("upstream"),
            model: text("model"),
            name: text("name"),
            provider: text("provider"),
            description: text("description"),
            enabled: existing?.enabled !== false,
          };
          for (const field of [
            "inputPrice",
            "outputPrice",
            "contextWindow",
          ] as const) {
            if (text(field)) m[field] = Number(text(field));
            else delete m[field];
          }
          if (!m.name) delete m.name;
          m.pricing = readModelPricing(f);
          if (!m.pricing) delete m.pricing;
          if (!m.provider) delete m.provider;
          if (text("reasoningEfforts"))
            m.reasoningEfforts = text("reasoningEfforts")
              .split(",")
              .map((s) => s.trim()) as ModelRoute["reasoningEfforts"];
          else delete m.reasoningEfforts;
          r.models[id] = m;
        }
      });
      if (dialog?.type === "channel") openGraph(id);
    } catch {}
  }
  if (graph)
    return (
      <ChannelGraphEditor
        host={host}
        key={graph.channelId}
        channelId={graph.channelId}
        initialPanel={graph.panel}
        close={() => {
          host.navigate("/ai-router");
          loaded.reload();
        }}
        saved={() => loaded.reload()}
      />
    );
  return (
    <>
      <PageHeading title={tr("渠道与路由")}>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => loaded.reload()}
        >
          <Icon name="refresh" size={15} />
          {tr("刷新")}
        </button>
        {(tab === "channels" || tab === "models") && (
          <button
            disabled={!loaded.data || busy}
            onClick={() =>
              setDialog({
                type: tab === "models" ? "model" : "channel",
                id: "",
              })
            }
          >
            <Icon name="plus" size={16} />
            {tab === "models" ? tr("添加模型") : tr("添加渠道")}
          </button>
        )}
      </PageHeading>
      <Notice message={message || loaded.error} />
      <div className="tabs" role="tablist" aria-label={tr("路由配置")}>
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
          {tr("模型映射 {0}", { "0": textValue(Object.keys(models).length) })}
        </button>
        <button
          role="tab"
          aria-selected={tab === "redirects"}
          className={tab === "redirects" ? "active" : ""}
          onClick={() => setTab("redirects")}
        >
          {tr("模型重定向 {0}", {
            "0": textValue(Object.keys(router.redirects ?? {}).length),
          })}
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
      {tab === "redirects" && (
        <Redirects
          rules={router.redirects ?? {}}
          targets={[
            ...Object.keys(models),
            ...Object.keys(router.redirects ?? {}),
          ]}
          save={mutate}
        />
      )}
      {tab === "channels" &&
        (Object.keys(upstreams).length ? (
          <ChannelTable
            upstreams={upstreams}
            models={models}
            busy={busy}
            testing={testing}
            tests={tests}
            edit={(id) => setDialog({ type: "channel", id })}
            graph={openGraph}
            toggle={(id, enabled) =>
              mutate((r) => setChannelState(r.upstreams, [id], enabled))
            }
            test={(id) => void test(id)}
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
      {tab === "models" &&
        (Object.keys(models).length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{tr("公开模型 / 名称")}</th>
                  <th>{tr("渠道 / 实际模型")}</th>
                  <th>{tr("原价 · USD")}</th>
                  <th>{tr("状态")}</th>
                  <th>{tr("操作")}</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(models).map(([id, m]) => (
                  <tr key={id}>
                    <td>
                      <strong>{m.name || id}</strong>
                      {m.name && m.name !== id && <small>{id}</small>}
                    </td>
                    <td>
                      {upstreams[m.upstream]?.name || m.upstream}
                      <small>{m.model}</small>
                    </td>
                    <td>
                      {m.pricing?.mode === "request" ? (
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
                        onClick={() => setDialog({ type: "model", id })}
                      >
                        {tr("编辑")}
                      </button>
                      <button
                        className="ghost"
                        disabled={busy}
                        onClick={() =>
                          mutate((r) => {
                            r.models[id]!.enabled = m.enabled === false;
                          })
                        }
                      >
                        {m.enabled === false ? tr("启用") : tr("停用")}
                      </button>
                      <button
                        className="ghost danger"
                        disabled={busy}
                        onClick={() =>
                          mutate((r) => {
                            delete r.models[id];
                          })
                        }
                      >
                        {tr("删除")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={tr("暂无模型映射")}>
            <button
              disabled={!Object.keys(upstreams).length}
              onClick={() => setDialog({ type: "model", id: "" })}
            >
              {tr("添加模型映射")}
            </button>
          </Empty>
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
          <h2>{tr("高级路由配置")}</h2>

          <textarea
            className="code"
            aria-label={tr("AI 路由配置")}
            rows={19}
            value={advanced}
            onChange={(e) => setAdvanced(e.target.value)}
          />
          <p>
            <button disabled={busy || !loaded.data}>{tr("保存并应用")}</button>
          </p>
        </form>
      )}

      {dialog && (
        <Dialog
          title={
            (dialog.id ? tr("编辑") : tr("添加")) +
            (dialog.type === "channel" ? tr("渠道") : tr("模型映射"))
          }
          close={() => {
            if (!busy) setDialog(undefined);
          }}
        >
          <form onSubmit={submit} key={dialog.type + dialog.id}>
            <Notice message={message} />
            <div className="form-grid">
              {!dialog.id && dialog.type === "model" && (
                <label className="full">
                  {tr("公开模型 ID")}
                  <input
                    name="id"
                    required
                    pattern={"[a-zA-Z0-9][a-zA-Z0-9._\\-\\/]{0,127}"}
                    placeholder="my-chat-model"
                  />
                </label>
              )}
              <label className="full">
                {tr("显示名称")}
                <input
                  name="name"
                  defaultValue={existing?.name ?? ""}
                  maxLength={128}
                  placeholder={tr("便于识别的名称（可选）")}
                />
              </label>
              {dialog.type === "model" && (
                <>
                  <label>
                    {tr("渠道")}
                    <Select
                      name="upstream"
                      required
                      defaultValue={existing?.upstream ?? ""}
                    >
                      <option value="" disabled>
                        {tr("选择渠道")}
                      </option>
                      {Object.entries(upstreams).map(([id, u]) => (
                        <option key={id} value={id}>
                          {u.name || id}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <label>
                    {tr("实际模型 ID")}
                    <input
                      name="model"
                      required
                      defaultValue={existing?.model ?? ""}
                      placeholder={tr("服务商提供的模型 ID")}
                    />
                  </label>
                  <label>
                    {tr("供应商")}
                    <input
                      name="provider"
                      defaultValue={existing?.provider ?? ""}
                      placeholder={tr("OpenAI / Anthropic / 自定义")}
                    />
                  </label>
                  <label>
                    {tr("上下文长度")}
                    <input
                      name="contextWindow"
                      type="number"
                      min="1"
                      max="100000000"
                      step="1"
                      defaultValue={existing?.contextWindow ?? ""}
                      placeholder={tr("可选")}
                    />
                  </label>
                  <ModelPriceFields model={existing} />
                  <label className="full">
                    {tr("支持的思考档位（逗号分隔）")}
                    <input
                      name="reasoningEfforts"
                      defaultValue={existing?.reasoningEfforts?.join(",") ?? ""}
                      placeholder={tr(
                        "low,medium,high（按服务商实际支持填写）",
                      )}
                    />
                  </label>
                  <label className="full">
                    {tr("模型描述")}
                    <textarea
                      name="description"
                      rows={3}
                      maxLength={1024}
                      defaultValue={existing?.description ?? ""}
                      placeholder={tr("向使用者说明模型适合的任务…")}
                    />
                  </label>
                </>
              )}
              {dialog.type === "channel" && (
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
              )}
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
                {busy
                  ? tr("保存中…")
                  : dialog.type === "channel"
                    ? tr("保存并编辑流程")
                    : tr("保存并应用")}
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
