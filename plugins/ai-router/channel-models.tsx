import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import type { ModelRoute } from "@pluhub/contracts/ai";
import { Checkbox } from "../../lib/ui/checkbox.js";
import { Dialog, Empty, Icon, number } from "../../lib/ui/components.js";
import { t as tr, textValue } from "../../lib/ui/i18n.js";
import { Notice } from "../../lib/ui/mount.js";

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
  channelName,
  models,
  add,
  close,
}: {
  host: UIHost;
  channelId: string;
  channelName: string;
  models: Record<string, ModelRoute>;
  add: (models: ChannelModel[]) => Promise<void>;
  close: () => void;
}) {
  const [data, setData] = React.useState<Response>();
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState<string[]>([]);
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setMessage("");
    void host
      .request<Response>("/api/plugins/official.ai-router/channel-models", {
        method: "POST",
        body: JSON.stringify({ id: channelId }),
      })
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((error) => {
        if (!cancelled) setMessage(tr((error as Error).message));
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, host]);

  const channelMappings = Object.values(models).filter(
    (model) => model.upstream === channelId,
  );
  const mapped = new Set(channelMappings.map((model) => model.model));
  const filtered = (data?.models ?? []).filter((model) =>
    [model.id, model.name ?? "", ...model.protocols]
      .join(" ")
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const stateFor = (model: ChannelModel) =>
    mapped.has(model.id)
      ? "mapped"
      : Object.hasOwn(models, model.id)
        ? "conflict"
        : "available";
  const selectable = filtered.filter(
    (model) => stateFor(model) === "available",
  );
  const visibleSelected = selectable.filter((model) =>
    selected.includes(model.id),
  ).length;
  const allSelected =
    selectable.length > 0 && visibleSelected === selectable.length;
  async function submit() {
    const picked = (data?.models ?? []).filter(
      (model) =>
        selected.includes(model.id) && stateFor(model) === "available",
    );
    if (!picked.length) return;
    setBusy(true);
    setMessage("");
    try {
      await add(picked);
      close();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={tr("{0} · 模型", {
        "0": channelName || channelId,
      })}
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
      <div className="channel-summary">
        <span>
          <strong>{data?.models.length ?? 0}</strong> {tr("上游可用模型")}
        </span>
        <span>
          <strong>{channelMappings.length}</strong> {tr("已映射模型")}
        </span>
      </div>
      <div className="data-toolbar" role="search">
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
        <label className="checkbox">
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
          {tr("全选")}
        </label>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="selection-cell" />
              <th>{tr("模型")}</th>
              <th>{tr("协议")}</th>
              <th>{tr("状态")}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((model) => {
              const state = stateFor(model);
              return (
                <tr key={model.id}>
                  <td className="selection-cell">
                    <Checkbox
                      aria-label={tr("选择模型 {0}", { "0": model.id })}
                      checked={selected.includes(model.id)}
                      disabled={state !== "available" || busy}
                      onCheckedChange={() =>
                        setSelected((current) =>
                          current.includes(model.id)
                            ? current.filter((id) => id !== model.id)
                            : [...current, model.id],
                        )
                      }
                    />
                  </td>
                  <td>
                    <strong>{model.name || model.id}</strong>
                    <small>
                      {model.name && model.name !== model.id && model.id + " · "}
                      {model.contextLength &&
                        tr("上下文 {0}", {
                          "0": number(model.contextLength),
                        })}
                      {model.maxOutputTokens &&
                        " · " +
                          tr("输出 {0}", {
                            "0": number(model.maxOutputTokens),
                          })}
                    </small>
                  </td>
                  <td>{model.protocols.join(" / ")}</td>
                  <td>
                    <span
                      className={
                        "badge " + (state === "available" ? "ready" : "")
                      }
                    >
                      {state === "mapped"
                        ? tr("已映射")
                        : state === "conflict"
                          ? tr("已被其他渠道映射")
                          : tr("可添加")}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!data && !message && <p className="muted">{tr("正在读取模型…")}</p>}
        {data && !filtered.length && (
          <Empty title={tr("没有匹配的模型")}>
            {query && (
              <button className="secondary" onClick={() => setQuery("")}>
                {tr("清除筛选")}
              </button>
            )}
          </Empty>
        )}
      </div>
      <div className="form-actions">
        <span className="muted">
          {tr("已选择 {0}", { "0": textValue(selected.length) })}
        </span>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={close}
        >
          {tr("关闭")}
        </button>
        <button
          type="button"
          disabled={!selected.length || busy}
          onClick={() => void submit()}
        >
          {busy ? tr("正在添加…") : tr("添加选中模型")}
        </button>
      </div>
    </Dialog>
  );
}
