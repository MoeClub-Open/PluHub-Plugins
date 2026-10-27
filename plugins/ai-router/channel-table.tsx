import { Checkbox } from "../../lib/ui/checkbox.js";
import { t as tr, textValue } from "../../lib/ui/i18n.js";
import { Select } from "../../lib/ui/select.js";
import React from "react";
import type { Upstream, ModelRoute } from "@pluhub/contracts/ai";
import { Empty, Icon, Dialog } from "../../lib/ui/components.js";
import { channelConnections } from "../../lib/ai/channel-config.js";
import { isDecisionProtocol } from "../../lib/ai/decision-route-kind.js";
import { filterChannels } from "../../lib/ai/channel-list.js";

function decisionOnly(channel: Upstream) {
  const flow = channel.flow;
  if (!flow) return isDecisionProtocol(channel.protocol);
  const ends = flow.nodes.filter((node) =>
    ["provider", "platform", "routing", "upstream", "response"].includes(node.type),
  );
  return (
    ends.length > 0 &&
    ends.every(
      (node) =>
        node.type === "provider" &&
        isDecisionProtocol(node.upstream?.protocol ?? channel.protocol) &&
        !node.fallback &&
        !flow.bindings?.some(
          (binding) => binding.target === node.id && binding.input === "upstream.protocol",
        ),
    )
  );
}

export function ChannelTable({
  upstreams,
  models,
  busy,
  testing,
  tests,
  edit,
  graph,
  modelsFor,
  toggle,
  test,
  remove,
  batch,
}: {
  upstreams: Record<string, Upstream>;
  models: Record<string, ModelRoute>;
  busy: boolean;
  testing: string;
  tests: Record<string, string>;
  edit: (id: string) => void;
  graph: (id: string) => void;
  modelsFor: (id: string) => void;
  toggle: (id: string, enabled: boolean) => void;
  test: (id: string) => void;
  remove: (id: string) => void;
  batch: (ids: string[], enabled: boolean) => Promise<void>;
}) {
  const [query, setQuery] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(10);
  const [selection, setSelection] = React.useState<string[]>([]);
  const [confirmStop, setConfirmStop] = React.useState(false);
  const ids = Object.keys(upstreams);
  const filtered = filterChannels(upstreams, models, query, status, "");
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const rows = filtered.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );
  const selected = selection.filter((id) => Object.hasOwn(upstreams, id));
  const selectedOnPage = rows.filter(([id]) => selected.includes(id)).length;
  const allSelected = rows.length > 0 && selectedOnPage === rows.length;
  React.useEffect(() => {
    setPage(1);
  }, [query, status, pageSize]);
  React.useEffect(() => {
    setPage((p) => Math.min(p, totalPages));
  }, [totalPages]);
  React.useEffect(() => {
    setSelection((old) => old.filter((id) => Object.hasOwn(upstreams, id)));
  }, [ids.join("\0")]);
  function reset() {
    setQuery("");
    setStatus("");
  }
  async function changeState(enabled: boolean) {
    try {
      await batch(selected, enabled);
      setSelection([]);
      setConfirmStop(false);
    } catch {
      setConfirmStop(false); /* Parent displays the configuration error. */
    }
  }
  return (
    <>
      <div className="channel-summary">
        <span>
          <strong>{ids.length}</strong> {tr("全部渠道")}
        </span>
        <span>
          <i className="status-dot" />
          <strong>
            {ids.filter((id) => upstreams[id]!.enabled !== false).length}
          </strong>{" "}
          {tr("已启用")}
        </span>
        <span>
          <strong>
            {ids.filter((id) => upstreams[id]!.enabled === false).length}
          </strong>{" "}
          {tr("已停用")}
        </span>
        <span>
          <strong>{Object.keys(models).length}</strong> {tr("模型映射")}
        </span>
      </div>
      <div className="data-toolbar" role="search" aria-label={tr("筛选渠道")}>
        <label className="data-search">
          <Icon name="search" size={17} />
          <input
            type="search"
            aria-label={tr("搜索渠道或模型")}
            placeholder={tr("搜索渠道、地址或模型…")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <Select
          aria-label={tr("渠道状态")}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">{tr("全部状态")}</option>
          <option value="enabled">{tr("已启用")}</option>
          <option value="disabled">{tr("已停用")}</option>
        </Select>
        {(query || status) && (
          <button className="ghost" onClick={reset}>
            {tr("重置筛选")}
          </button>
        )}
      </div>
      {selected.length > 0 && (
        <div
          className="selection-bar"
          role="region"
          aria-label={tr("渠道批量操作")}
        >
          <span>
            {tr("已选择")}
            <strong>{selected.length}</strong> {tr("个渠道")}
            {selected.length > selectedOnPage &&
              tr("（其中 {0} 个不在当前页）", {
                "0": textValue(selected.length - selectedOnPage),
              })}
          </span>
          <div className="actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void changeState(true)}
            >
              {tr("批量启用")}
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setConfirmStop(true)}
            >
              {tr("批量停用")}
            </button>
            <button
              className="ghost"
              disabled={busy}
              onClick={() => setSelection([])}
            >
              {tr("清空选择")}
            </button>
          </div>
        </div>
      )}
      <div className="table-wrap channel-table">
        <table>
          <thead>
            <tr>
              <th className="selection-cell">
                <Checkbox
                  indeterminate={selectedOnPage > 0 && !allSelected}
                  className="table-check"
                  aria-label={tr("选择本页渠道")}
                  checked={allSelected}
                  disabled={!rows.length || busy}
                  onCheckedChange={() =>
                    setSelection((old) =>
                      allSelected
                        ? old.filter(
                            (id) => !rows.some(([rowId]) => rowId === id),
                          )
                        : [...new Set([...old, ...rows.map(([id]) => id)])],
                    )
                  }
                />
              </th>
              <th>{tr("渠道")}</th>
              <th>{tr("流程 / 上游")}</th>
              <th>{tr("模型")}</th>
              <th>{tr("状态")}</th>
              <th>{tr("操作")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([id, channel]) => {
              const channelModels = Object.entries(models)
                .filter(([, model]) => model.upstream === id)
                .map(([alias, model]) => model.name || alias);
              return (
                <tr
                  key={id}
                  className={selected.includes(id) ? "row-selected" : undefined}
                >
                  <td className="selection-cell">
                    <Checkbox
                      className="table-check"
                      aria-label={tr("选择渠道 ") + (channel.name || id)}
                      checked={selected.includes(id)}
                      disabled={busy}
                      onCheckedChange={() =>
                        setSelection((old) =>
                          old.includes(id)
                            ? old.filter((key) => key !== id)
                            : [...old, id],
                        )
                      }
                    />
                  </td>
                  <td>
                    <strong>{channel.name || id}</strong>
                    <small>
                      {tr("优先级")} {channel.priority ?? 0}
                    </small>
                    {channel.name && channel.name !== id && <small>{id}</small>}
                  </td>
                  <td>
                    <span>
                      {tr("{0} 个节点 · {1} 个上游", {
                        "0": textValue(channel.flow?.nodes.length ?? 2),
                        "1": textValue(channelConnections(channel).length),
                      })}
                    </span>
                    {channelConnections(channel).some(
                      (connection) => !!connection.keyRef,
                    ) && (
                      <small>
                        {channelConnections(channel).reduce(
                          (count, connection) =>
                            count +
                            (Array.isArray(connection.keyRef)
                              ? connection.keyRef.length
                              : connection.keyRef
                                ? 1
                                : 0),
                          0,
                        )}{" "}
                        Key
                      </small>
                    )}
                    <small className="channel-address">
                      {channelConnections(channel)
                        .map((u) => u.baseUrl)
                        .filter(Boolean)
                        .join(" · ") || tr("按流程选择目标")}
                    </small>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy}
                      onClick={() => modelsFor(id)}
                    >
                      <Icon name="eye" size={14} />
                      {tr("模型与定价")}
                      <span className="badge">{channelModels.length}</span>
                    </button>
                    <small title={channelModels.join("、")}>
                      {channelModels.slice(0, 3).join("、") || tr("未添加模型")}
                      {channelModels.length > 3 &&
                        tr(" 等 {0} 个", {
                          "0": textValue(channelModels.length),
                        })}
                    </small>
                  </td>
                  <td>
                    <span
                      className={
                        "badge " + (channel.enabled !== false ? "ready" : "")
                      }
                    >
                      {channel.enabled === false ? tr("已停用") : tr("已启用")}
                    </span>
                    <small>{tests[id] || tr("尚未测试")}</small>
                  </td>
                  <td>
                    <div className="actions">
                      <button
                        className="ghost"
                        disabled={busy}
                        onClick={() => graph(id)}
                      >
                        {tr("编辑流程")}
                      </button>
                      <button
                        className="ghost"
                        disabled={busy}
                        onClick={() => edit(id)}
                      >
                        {tr("设置")}
                      </button>
                      <button
                        className="ghost"
                        disabled={busy}
                        onClick={() => toggle(id, channel.enabled === false)}
                      >
                        {channel.enabled === false ? tr("启用") : tr("停用")}
                      </button>
                      {!decisionOnly(channel) && (
                        <button
                          className="ghost"
                          disabled={busy || !!testing}
                          title={tr("真实调用，最多 256 Token，按上游计费")}
                          onClick={() => test(id)}
                        >
                          {testing === id ? tr("测试中…") : tr("发送测试请求")}
                        </button>
                      )}
                      <button
                        className="ghost danger"
                        disabled={
                          busy ||
                          Object.values(models).some(
                            (model) => model.upstream === id,
                          )
                        }
                        onClick={() => remove(id)}
                      >
                        {tr("删除")}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && (
          <Empty title={tr("没有匹配的渠道")}>
            <button className="secondary" onClick={reset}>
              {tr("清除筛选")}
            </button>
          </Empty>
        )}
      </div>
      <div className="data-pagination">
        <span>
          {tr("共 {0} 个结果 {1}", {
            "0": textValue(filtered.length),
            "1": textValue(
              filtered.length !== ids.length ? ` / ${ids.length} 个渠道` : "",
            ),
          })}
        </span>
        <div className="actions">
          <label>
            {tr("每页")}
            <Select
              aria-label={tr("每页渠道数")}
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
            >
              {[10, 20, 50].map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </Select>
          </label>
          <button
            className="secondary"
            disabled={currentPage <= 1}
            onClick={() => setPage(currentPage - 1)}
          >
            {tr("上一页")}
          </button>
          <span>
            {currentPage} / {totalPages}
          </span>
          <button
            className="secondary"
            disabled={currentPage >= totalPages}
            onClick={() => setPage(currentPage + 1)}
          >
            {tr("下一页")}
          </button>
        </div>
      </div>
      {confirmStop && (
        <Dialog
          title={tr("停用所选渠道")}
          close={() => {
            if (!busy) setConfirmStop(false);
          }}
        >
          <p>
            {tr(
              "将停用 {0} 个渠道，包括当前筛选之外的选择。依赖这些渠道的 {1} 个模型映射将无法通过这些渠道接收新请求。",
              {
                "0": textValue(selected.length),
                "1": textValue(
                  Object.values(models).filter((model) =>
                    selected.includes(model.upstream),
                  ).length,
                ),
              },
            )}
          </p>
          <p className="muted">
            {selected.map((id) => upstreams[id]?.name || id).join("、")}
          </p>
          <div className="actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setConfirmStop(false)}
            >
              {tr("取消")}
            </button>
            <button disabled={busy} onClick={() => void changeState(false)}>
              {busy ? tr("正在应用…") : tr("确认停用")}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
