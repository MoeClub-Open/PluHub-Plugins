import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import type { ModelRoute, Upstream } from "@pluhub/contracts/ai";
import { Checkbox } from "../../lib/ui/checkbox.js";
import { Select } from "../../lib/ui/select.js";
import {
  Dialog,
  Empty,
  Icon,
  ListPagination,
} from "../../lib/ui/components.js";
import { t as tr, textValue } from "../../lib/ui/i18n.js";
import { Notice } from "../../lib/ui/mount.js";
import { channelConnections } from "../../lib/ai/channel-config.js";
import { isDecisionProtocol } from "../../lib/ai/decision-route-kind.js";

export type ChannelModel = {
  id: string;
  name?: string;
  contextLength?: number;
  maxOutputTokens?: number;
  protocols: string[];
};

type Response = {
  models: ChannelModel[];
  errors: { protocol: string; message: string }[];
};

export function ChannelModels({
  host,
  channelId,
  upstreams,
  models,
  changeChannel,
  add,
  edit,
  create,
  close,
}: {
  host: UIHost;
  channelId: string;
  upstreams: Record<string, Upstream>;
  models: Record<string, ModelRoute>;
  changeChannel: (id: string) => void;
  add: (id: string, models: ChannelModel[]) => Promise<void>;
  edit: (id: string) => void;
  create: (channelId: string, model?: ChannelModel) => void;
  close: () => void;
}) {
  const [data, setData] = React.useState<Response>();
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState<string[]>([]);
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [revision, setRevision] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(20);
  const channel = upstreams[channelId];
  const canDiscover = !!channel && channelConnections(channel).some(
    (connection) => !isDecisionProtocol(connection.protocol),
  );

  React.useEffect(() => {
    const controller = new AbortController();
    setData(undefined);
    setMessage("");
    setSelected([]);
    if (!canDiscover) {
      setData({ models: [], errors: [] });
      return () => controller.abort();
    }
    void host
      .request<Response>("/api/plugins/official.ai-router/channel-models", {
        method: "POST",
        body: JSON.stringify({ id: channelId }),
        signal: controller.signal,
      })
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setMessage(tr((error as Error).message));
      });
    return () => controller.abort();
  }, [channelId, host, revision, canDiscover]);
  React.useEffect(() => setPage(1), [channelId, query, pageSize]);

  const mappings = Object.entries(models).filter(
    ([, model]) => model.upstream === channelId,
  );
  const mapped = new Set(mappings.map(([, model]) => model.model));
  const directory = new Map(
    (data?.models ?? []).map((model) => [model.id, model]),
  );
  for (const [, model] of mappings) {
    if (!directory.has(model.model))
      directory.set(model.model, {
        id: model.model,
        name: model.name,
        protocols: [],
      });
  }
  const filtered = [...directory.values()].filter((model) =>
    [
      model.id,
      model.name ?? "",
      ...model.protocols,
      ...mappings
        .filter(([, route]) => route.model === model.id)
        .map(([id]) => id),
    ]
      .join(" ")
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const selectable = filtered.filter((model) => !mapped.has(model.id));
  const visibleSelected = selectable.filter((model) =>
    selected.includes(model.id),
  ).length;
  const allSelected =
    selectable.length > 0 && visibleSelected === selectable.length;
  const picked = (data?.models ?? []).filter(
    (model) => selected.includes(model.id) && !mapped.has(model.id),
  );
  const rows = filtered.flatMap<{
    model: ChannelModel;
    id: string;
    route: ModelRoute | undefined;
  }>((model) => {
    const routes = mappings.filter(([, route]) => route.model === model.id);
    return routes.length
      ? routes.map(([id, route]) => ({ model, id, route }))
      : [{ model, id: "", route: undefined }];
  });
  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(rows.length / pageSize)),
  );
  async function submit() {
    if (!picked.length) return;
    setBusy(true);
    setMessage("");
    try {
      await add(channelId, picked);
      setSelected([]);
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={tr("模型与定价")}
      close={() => {
        if (!busy) close();
      }}
    >
      <Notice
        message={
          message ||
          data?.errors
            .map(
              (error) =>
                (error.protocol ? tr("{0}：", { "0": error.protocol }) : "") +
                tr(error.message),
            )
            .join(" · ") ||
          ""
        }
      />
      <div className="data-toolbar" role="search">
        <Select
          aria-label={tr("渠道")}
          value={channelId}
          disabled={busy}
          onChange={(event) => changeChannel(event.target.value)}
        >
          {Object.entries(upstreams).map(([id, upstream]) => (
            <option key={id} value={id}>
              {upstream.name || id} · ×{upstream.consumptionMultiplier ?? 1}
            </option>
          ))}
        </Select>
        <label className="data-search">
          <Icon name="search" size={17} />
          <input
            type="search"
            aria-label={tr("搜索渠道模型")}
            placeholder={tr("搜索模型 ID 或名称")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {canDiscover && (
          <button
            type="button"
            className="icon-button"
            aria-label={tr("刷新模型")}
            disabled={busy || (!data && !message)}
            onClick={() => setRevision((value) => value + 1)}
          >
            <Icon name="refresh" size={15} />
          </button>
        )}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {canDiscover && <th className="selection-cell">
                <Checkbox
                  aria-label={tr("选择全部可用模型")}
                  checked={allSelected}
                  indeterminate={visibleSelected > 0 && !allSelected}
                  disabled={!selectable.length || busy}
                  onCheckedChange={(checked) =>
                    setSelected((current) =>
                      checked
                        ? [
                            ...new Set([
                              ...current,
                              ...selectable.map((model) => model.id),
                            ]),
                          ]
                        : current.filter(
                            (id) =>
                              !selectable.some((model) => model.id === id),
                          ),
                    )
                  }
                />
              </th>}
              <th>{tr("模型")}</th>
              <th>{tr("原价 · USD")}</th>
              <th>{tr("状态")}</th>
              <th>{tr("操作")}</th>
            </tr>
          </thead>
          <tbody>
            {rows
              .slice((currentPage - 1) * pageSize, currentPage * pageSize)
              .map(({ model, id, route }) => (
                <tr key={model.id + ":" + id}>
                  {canDiscover && <td className="selection-cell">
                    <Checkbox
                      aria-label={tr("选择模型 {0}", { "0": model.id })}
                      checked={selected.includes(model.id) && !route}
                      disabled={!!route || busy}
                      onCheckedChange={(checked) =>
                        setSelected((current) =>
                          checked
                            ? [...current, model.id]
                            : current.filter((value) => value !== model.id),
                        )
                      }
                    />
                  </td>}
                  <td>
                    <strong>{route?.name || model.name || model.id}</strong>
                    {(route?.name || model.name || model.id) !==
                      (id || model.id) && <small>{id || model.id}</small>}
                    {id && id !== model.id && <small>{model.id}</small>}
                  </td>
                  <td>
                    {!route ? (
                      "—"
                    ) : route.pricing?.mode === "expression" ? (
                      tr("动态定价")
                    ) : route.pricing?.mode === "request" ? (
                      "$" + route.pricing.request + " / " + tr("次")
                    ) : route.inputPrice === undefined ||
                      route.outputPrice === undefined ? (
                      tr("未定价")
                    ) : (
                      <>
                        {route.inputPrice} / {route.outputPrice}
                        <small>{tr("USD / 百万 Token")}</small>
                      </>
                    )}
                  </td>
                  <td>
                    <span
                      className={
                        "badge " +
                        (route?.enabled !== false && route ? "ready" : "")
                      }
                    >
                      {!route
                        ? tr("可添加")
                        : route.enabled === false
                          ? tr("已停用")
                          : tr("已添加")}
                    </span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy}
                      onClick={() =>
                        route ? edit(id) : create(channelId, model)
                      }
                    >
                      {route ? tr("编辑") : tr("添加并定价")}
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        {!data && !message && <p className="muted">{tr("正在读取模型…")}</p>}
        {(data || message) && !rows.length && (
          <Empty title={tr("没有匹配的模型")} />
        )}
      </div>
      <ListPagination
        total={rows.length}
        page={currentPage}
        size={pageSize}
        setPage={setPage}
        setSize={setPageSize}
      />
      <div className="form-actions">
        {canDiscover && <span className="muted">
          {tr("已选择 {0}", { "0": textValue(picked.length) })}
        </span>}
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => create(channelId)}
        >
          {tr("手动添加")}
        </button>
        {canDiscover && <button
          type="button"
          disabled={!picked.length || busy}
          onClick={() => void submit()}
        >
          {busy ? tr("正在添加…") : tr("添加选中模型")}
        </button>}
      </div>
    </Dialog>
  );
}
