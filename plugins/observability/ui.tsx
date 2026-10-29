import { requestErrorHint } from "../../lib/ui/request-error.js";
import { billingNote } from "../../lib/ui/billing-note.js";
import { t as tr, textValue, getLocale } from "../../lib/ui/i18n.js";
import { Select } from "../../lib/ui/select.js";
import { modelEndpoints } from "../../lib/ui/model-endpoints.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { mountPage, useLoad, Notice } from "../../lib/ui/mount.js";
import { downloadCsv } from "../../lib/ui/download.js";
import { priceUsage } from "../../lib/commerce/pricing.js";
import { fixedPricing } from "../../lib/commerce/expression.js";
import { PriceReceiptView } from "../../lib/ui/price-receipt.js";
import { RoutingDetails } from "./routing-details.js";
import {
  ConsumptionBreakdown,
  consumptionLabel,
  consumptionSources,
  walletNote,
  TokenStat,
} from "../../lib/ui/consumption.js";
import {
  PageHeading,
  Icon,
  Empty,
  Dialog,
  Stat,
  number,
  latency,
  money,
  type Summary,
} from "../../lib/ui/components.js";
const names: Record<string, string> = {
  get success() {
    return tr("成功");
  },
  get error() {
    return tr("失败");
  },
  get cancelled() {
    return tr("已取消");
  },
};
const billingStatus = (status: string) =>
  tr(
    (
      {
        reserved: "预留中",
        released: "已释放",
        personal: "不扣余额",
        disabled: "未启用计费",
        unavailable: "计费记录不可用",
        unknown: "无结算记录",
        not_started: "未进入计费",
        workflow: "由流程内部调用计费",
      } as Record<string, string>
    )[status] ?? "无结算记录",
  );
function localDate(value: string) {
  const date = new Date(Number(value));
  return Number.isFinite(date.getTime())
    ? new Date(date.getTime() - date.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16)
    : "";
}
function estimateReceipt(row: any) {
  try {
    if (!row.pricing_json) return null;
    const pricing = JSON.parse(row.pricing_json);
    const usage = row.usage_json
      ? JSON.parse(row.usage_json)
      : fixedPricing(pricing)
        ? {
            input: 0,
            output: 0,
            webSearch: JSON.parse(row.routing ?? "{}").webSearchCalls ?? 0,
          }
        : null;
    if (!usage) return null;
    const receipt = priceUsage(usage, pricing);
    if (row.cost_micro_usd !== null && row.cost_micro_usd !== undefined)
      receipt.amount = row.cost_micro_usd;
    return JSON.stringify(receipt);
  } catch {
    return null;
  }
}
function WorkflowCalls({ host, parentId }: { host: UIHost; parentId: string }) {
  const calls = useLoad<{ data: any[] }>(
    () =>
      host.request(
        "/api/plugins/official.observability/requests/children?parentId=" +
          encodeURIComponent(parentId),
      ),
    [parentId],
  );
  if (calls.error) return <Notice message={calls.error} />;
  if (!calls.data) return <p className="field-note">{tr("正在加载流程内部调用…")}</p>;
  if (!calls.data.data.length) return null;
  return (
    <section>
      <h3>{tr("流程内部调用")}</h3>
      {calls.data.data.map((row) => (
        <WorkflowCall key={row.id} host={host} row={row} />
      ))}
    </section>
  );
}
function WorkflowCall({ host, row }: { host: UIHost; row: any }) {
  const [expanded, setExpanded] = React.useState(false);
  return (
    <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>
        {row.workflow_node_id || "—"} · {row.model || "—"} · {names[row.status] ?? row.status}
      </summary>
      {expanded && (
        <>
          <dl className="detail-grid">
            {Object.entries({
              "请求 ID": row.id,
              状态: names[row.status] ?? row.status,
              错误代码: row.error_code || "—",
              消耗来源: consumptionLabel(row.consumption_source),
              耗时: latency(row.latency_ms),
              "输入 Token": number(row.input_tokens),
              "输出 Token": number(row.output_tokens),
              "TPS（输出 / 总耗时）": number(row.output_tps),
              "估算消耗 (USD)": money(
                row.cost_micro_usd == null ? null : row.cost_micro_usd / 1000000,
              ),
              "实际扣费 (USD)": money(
                row.charged_micro_usd == null ? null : row.charged_micro_usd / 1000000,
              ),
              "预留金额 (USD)": money(
                row.held_micro_usd == null ? null : row.held_micro_usd / 1000000,
              ),
              ...(row.billing_status !== "settled"
                ? { 计费状态: billingStatus(row.billing_status) }
                : {}),
              ...(row.billing_note ? { 计费说明: billingNote(row.billing_note) } : {}),
            }).map(([label, value]) => (
              <div key={label}>
                <dt>{tr(label)}</dt>
                <dd>{value as React.ReactNode}</dd>
              </div>
            ))}
          </dl>
          {row.billing_receipt && (
            <PriceReceiptView value={row.billing_receipt} title={tr("实际扣费明细")} />
          )}
          <PriceReceiptView
            value={estimateReceipt(row)}
            title={tr("费用估算明细")}
            showMultiplier={!["byoapi", "byosub", "personal"].includes(row.consumption_source)}
          />
          {(row.routing || row.upstream_response_model) && (
            <RoutingDetails value={row.routing} requestedModel={row.model} responseModel={row.upstream_response_model} />
          )}
          <WorkflowCalls host={host} parentId={row.id} />
        </>
      )}
    </details>
  );
}
function Page({ host }: { host: UIHost }) {
  const [initial] = React.useState(
    () => new URLSearchParams(location.hash.split("?")[1]),
  );
  const [hours, setHours] = React.useState(
    [24, 168, 720].includes(Number(initial.get("hours")))
      ? Number(initial.get("hours"))
      : 24,
  );
  const [status, setStatus] = React.useState(initial.get("status") ?? "");
  const [model, setModel] = React.useState(initial.get("model") ?? "");
  const [queryModel, setQueryModel] = React.useState(
    initial.get("model") ?? "",
  );
  const [requestId, setRequestId] = React.useState(
    initial.get("requestId") ?? "",
  );
  const [queryRequestId, setQueryRequestId] = React.useState(
    initial.get("requestId") ?? "",
  );
  const [advanced, setAdvanced] = React.useState(false);
  const initialFilters = Object.fromEntries(
    [
      "protocol",
      "source",
      "upstream",
      "keyId",
      "errorCode",
      "userId",
      "from",
      "to",
    ].flatMap((key) => (initial.get(key) ? [[key, initial.get(key)!]] : [])),
  );
  const [filters, setFilters] =
    React.useState<Record<string, string>>(initialFilters);
  const [draft, setDraft] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(initialFilters).map(([key, value]) => [
        key,
        key === "from" || key === "to" ? localDate(value) : value,
      ]),
    ),
  );
  const [selfOnly, setSelfOnly] = React.useState(initial.get("scope") === "me");
  const [exporting, setExporting] = React.useState(false),
    [message, setMessage] = React.useState("");
  const scope = useLoad<{
    scope: string;
    users: { id: string; name: string }[];
  }>(() => host.request("/api/plugins/official.observability/log-scope"));
  const displayUser = (id: string) =>
    scope.data?.users.find((user) => user.id === id)?.name || tr("未知用户");
  const displayKey = (row: any) =>
    row.key_name || (row.key_id ? tr("名称不可用") : tr("控制台会话"));
  const channels = useLoad<{ id: string; name: string }[]>(() =>
    host.request("/api/plugins/official.ai-router/channels").catch(() => []),
  );
  const displayChannel = (id?: string) =>
    channels.data?.find((channel) => channel.id === id)?.name ??
    (id ? tr("渠道已删除或不可用") : "—");
  const [offset, setOffset] = React.useState(0);
  const [selected, setSelected] = React.useState<any>();
  const query = new URLSearchParams({
    hours: String(hours),
    ...(selfOnly ? { scope: "me" } : {}),
    ...filters,
    ...(status ? { status } : {}),
    ...(queryModel ? { model: queryModel } : {}),
    ...(queryRequestId ? { requestId: queryRequestId } : {}),
  });
  const matchingCalls =
    !queryRequestId &&
    !!(queryModel || status || filters.protocol || filters.source || filters.upstream || filters.errorCode);
  React.useEffect(() => {
    const next = new URL(location.href);
    next.hash = "/activity?" + query.toString();
    history.replaceState(history.state, "", next);
  }, [query.toString()]);
  const active = [
    ...(queryModel ? [["model", queryModel]] : []),
    ...(queryRequestId ? [["requestId", queryRequestId]] : []),
    ...(status ? [["status", names[status] ?? status]] : []),
    ...Object.entries(filters),
    ...(selfOnly ? [["scope", tr("仅自己")]] : []),
  ];
  function clear(key?: string) {
    if (!key || key === "model") {
      setModel("");
      setQueryModel("");
    }
    if (!key || key === "requestId") {
      setRequestId("");
      setQueryRequestId("");
    }
    if (!key || key === "status") setStatus("");
    if (!key || key === "scope") setSelfOnly(false);
    const remove = (values: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(values).filter(
          ([name]) =>
            key &&
            (key === "from" || key === "to"
              ? name !== "from" && name !== "to"
              : name !== key),
        ),
      );
    setFilters(remove);
    setDraft(remove);
    setOffset(0);
  }
  const data = useLoad<{ data: any[]; total: number }>(
    () =>
      host.request(
        "/api/plugins/official.observability/requests?" +
          query +
          "&offset=" +
          offset,
      ),
    [hours, status, queryModel, queryRequestId, filters, selfOnly, offset],
  );
  const stats = useLoad<Summary>(
    () => host.request("/api/plugins/official.observability/summary?" + query),
    [hours, status, queryModel, queryRequestId, filters, selfOnly],
  );
  React.useEffect(() => {
    if (queryRequestId) {
      const row = data.data?.data.find((row) => row.id === queryRequestId);
      if (row) setSelected(row);
    }
  }, [data.data, queryRequestId]);
  const reload = () => {
    data.reload();
    stats.reload();
  };
  return (
    <>
      <PageHeading title={tr("调用记录")}>
        <button
          className="secondary"
          disabled={exporting || !data.data?.total}
          onClick={() => {
            setExporting(true);
            setMessage("");
            void downloadCsv(
              "/api/plugins/official.observability/requests/export?" + query,
              "pluhub-requests.csv",
            )
              .catch((error) => setMessage(error.message))
              .finally(() => setExporting(false));
          }}
        >
          {tr("导出 CSV")}
        </button>
        <Select
          aria-label={tr("日志时间范围")}
          value={hours}
          onChange={(e) => {
            setHours(Number(e.target.value));
            setDraft(({ from, to, ...remaining }) => remaining);
            setFilters(({ from, to, ...remaining }) => remaining);
            setOffset(0);
          }}
        >
          <option value="24">{tr("最近 24 小时")}</option>
          <option value="168">{tr("最近 7 天")}</option>
          <option value="720">{tr("最近 30 天")}</option>
        </Select>
        <button className="secondary" onClick={reload}>
          <Icon name="refresh" size={16} />
          {tr("刷新")}
        </button>
      </PageHeading>
      <Notice message={message || data.error || stats.error || scope.error} />
      <div className="stats four">
        <Stat
          title={tr("请求数")}
          value={number(stats.data?.requests)}
          note={tr(
            queryRequestId
              ? "所选请求；用量和扣费包含其内部调用"
              : matchingCalls
                ? "按匹配调用统计，包含流程内部调用"
                : "外部请求及父记录缺失的内部调用",
          )}
          icon="activity"
        />
        <Stat
          title={tr("成功率")}
          value={
            stats.data && stats.data.successes + stats.data.errors > 0
              ? (
                  (100 * stats.data.successes) /
                  (stats.data.successes + stats.data.errors)
                ).toFixed(1) + "%"
              : "—"
          }
          note={tr("取消请求不计入失败")}
          icon="check"
        />
        <TokenStat
          input={stats.data?.inputTokens}
          output={stats.data?.outputTokens}
          note={tr("含流程内部调用")}
        />
        <Stat
          title={tr("消耗金额")}
          value={money(stats.data?.wallet.chargedUSD)}
          note={walletNote(stats.data?.wallet)}
          icon="money"
        />
      </div>
      <ConsumptionBreakdown value={stats.data?.consumption} />
      <form
        className="list-toolbar runtime-log-filters"
        onSubmit={(e) => {
          e.preventDefault();
          setQueryModel(model.trim());
          setQueryRequestId(requestId.trim());
          setFilters(
            Object.fromEntries(
              Object.entries(draft)
                .filter(([, value]) => value)
                .map(([key, value]) => [
                  key,
                  key === "from" || key === "to"
                    ? String(new Date(value).getTime())
                    : value.trim(),
                ]),
            ),
          );
          setOffset(0);
        }}
      >
        <div className="search-box">
          <Icon name="search" />
          <input
            aria-label={tr("按模型筛选日志")}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={tr("输入完整模型 ID 筛选…")}
          />
        </div>
        <Select
          aria-label={tr("日志状态")}
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">{tr("所有状态")}</option>
          <option value="success">{tr("成功")}</option>
          <option value="error">{tr("失败")}</option>
          <option value="cancelled">{tr("已取消")}</option>
        </Select>
        <Select
          aria-label={tr("消耗来源")}
          value={filters.source ?? ""}
          onChange={(e) => {
            const source = e.target.value;
            const update = ({
              source: _old,
              ...rest
            }: Record<string, string>) => (source ? { ...rest, source } : rest);
            setFilters(update);
            setDraft(update);
            setOffset(0);
          }}
        >
          <option value="">{tr("全部消耗来源")}</option>
          {Object.keys(consumptionSources).map((source) => (
            <option key={source} value={source}>
              {consumptionLabel(source)}
            </option>
          ))}
        </Select>
        {scope.data?.scope !== "self" && scope.data && (
          <Select
            aria-label={tr("查看范围")}
            value={selfOnly ? "me" : "visible"}
            onChange={(e) => {
              setSelfOnly(e.target.value === "me");
              setOffset(0);
            }}
          >
            <option value="visible">
              {scope.data.scope === "all" ? tr("全站请求") : tr("企业与子账号")}
            </option>
            <option value="me">{tr("仅自己")}</option>
          </Select>
        )}
        <button
          type="button"
          className="secondary"
          aria-expanded={advanced}
          onClick={() => setAdvanced(!advanced)}
        >
          {tr("更多筛选")}
        </button>
        {advanced && (
          <div className="request-log-advanced">
            <label>
              {tr("请求 ID")}
              <input
                value={requestId}
                maxLength={256}
                onChange={(e) => setRequestId(e.target.value)}
              />
            </label>
            {scope.data?.scope !== "self" && (
              <label>
                {tr("用户")}
                <Select
                  value={draft.userId ?? ""}
                  onChange={(e) =>
                    setDraft({ ...draft, userId: e.target.value })
                  }
                >
                  <option value="">{tr("全部用户")}</option>
                  {scope.data?.users.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            <label>
              {tr("入口协议")}
              <Select
                value={draft.protocol ?? ""}
                onChange={(e) =>
                  setDraft({ ...draft, protocol: e.target.value })
                }
              >
                <option value="">{tr("全部协议")}</option>
                {[
                  "openai-chat",
                  "openai-responses",
                  "anthropic",
                  "gemini",
                  ...modelEndpoints
                    .filter(([kind]) => kind !== "chat")
                    .map(([kind]) => kind),
                ].map((protocol) => (
                  <option key={protocol} value={protocol}>
                    {protocol}
                  </option>
                ))}
              </Select>
            </label>
            {[
              ["upstream", "渠道 ID"],
              ["keyId", "密钥 ID"],
              ["errorCode", "错误代码"],
            ].map(([key, label]) => (
              <label key={key}>
                {tr(label!)}
                <input
                  value={draft[key!] ?? ""}
                  maxLength={256}
                  onChange={(e) =>
                    setDraft({ ...draft, [key!]: e.target.value })
                  }
                />
              </label>
            ))}
            {[
              ["from", "开始时间"],
              ["to", "结束时间"],
            ].map(([key, label]) => (
              <label key={key}>
                {tr(label!)}
                <input
                  type="datetime-local"
                  value={draft[key!] ?? ""}
                  required={!!(draft.from || draft.to)}
                  onChange={(e) =>
                    setDraft({ ...draft, [key!]: e.target.value })
                  }
                />
              </label>
            ))}
          </div>
        )}
        <button className="secondary">{tr("筛选")}</button>
        <button type="button" className="ghost" onClick={() => clear()}>
          {tr("重置筛选")}
        </button>
      </form>
      {!!active.length && (
        <div
          className="actions"
          aria-label={tr("已应用筛选")}
          style={{ flexWrap: "wrap", marginBottom: 12 }}
        >
          {active.map(([key, value]) => (
            <button
              key={key}
              className="secondary"
              aria-label={tr("移除筛选：{0}", { "0": key! })}
              onClick={() => clear(key)}
            >
              <span
                style={{
                  maxWidth: 220,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {tr(
                  (
                    {
                      model: "模型",
                      requestId: "请求 ID",
                      status: "状态",
                      protocol: "入口协议",
                      upstream: "渠道",
                      keyId: "密钥 ID",
                      errorCode: "错误代码",
                      userId: "用户",
                      from: "开始时间",
                      to: "结束时间",
                      scope: "查看范围",
                      source: "消耗来源",
                    } as Record<string, string>
                  )[key!] ?? key!,
                )}
                :{" "}
                {key === "from" || key === "to"
                  ? new Date(Number(value)).toLocaleString(getLocale())
                  : key === "source"
                    ? consumptionLabel(value)
                    : value}
              </span>
              <Icon name="close" size={12} />
            </button>
          ))}
        </div>
      )}
      {data.data?.total === 0 ? (
        <Empty title={tr("还没有匹配的调用记录")} />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{tr("用户 / 时间")}</th>
                <th>API Key</th>
                <th>{tr("模型")}</th>
                <th>{tr("状态")}</th>
                <th>{tr("耗时")}</th>
                <th className="numeric">{tr("输入 / 输出")}</th>
                <th>{tr("估算消耗")}</th>
                <th>{tr("实际扣费")}</th>
                <th>{tr("详情")}</th>
              </tr>
            </thead>
            <tbody>
              {data.data?.data.map((r) => (
                <tr key={r.id}>
                  <td>
                    <strong>{r.user_name || displayUser(r.user_id)}</strong>
                    <small>
                      {new Date(r.created_at).toLocaleString(getLocale())}
                    </small>
                  </td>
                  <td>{displayKey(r)}</td>
                  <td>
                    <strong>{r.model || "—"}</strong>
                    <small>{consumptionLabel(r.consumption_source)}</small>
                    <small>
                      {tr("思考强度")}: {r.effort || "—"}
                    </small>
                  </td>
                  <td>
                    <span
                      className={
                        "badge " +
                        (r.status === "success"
                          ? "ready"
                          : r.status === "error"
                            ? "error"
                            : "")
                      }
                    >
                      {names[r.status]}
                    </span>
                  </td>
                  <td>
                    {latency(r.latency_ms)}
                    <small>
                      {latency(r.first_token_ms)} {tr("首 Token")}
                    </small>
                  </td>
                  <td className="numeric">
                    {number(r.input_tokens)} / {number(r.output_tokens)}
                    <small title={tr("输出 Token 数 / 请求总耗时（秒）")}>
                      {number(r.output_tps)} TPS
                    </small>
                  </td>
                  <td>
                    {money(
                      r.cost_micro_usd == null
                        ? null
                        : r.cost_micro_usd / 1000000,
                    )}
                  </td>
                  <td>
                    {money(
                      r.charged_micro_usd == null
                        ? null
                        : r.charged_micro_usd / 1000000,
                    )}
                  </td>
                  <td>
                    <button
                      className="ghost"
                      aria-label={tr("请求详情")}
                      onClick={() => setSelected(r)}
                    >
                      {tr("详情 ↗")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.data && data.data.total > 0 && (
        <div className="pagination">
          <span>
            {tr("共 {0} 条 · 第 {1} 页", {
              "0": textValue(data.data.total),
              "1": textValue(Math.floor(offset / 20) + 1),
            })}
          </span>
          <div className="actions">
            <button
              className="secondary"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 20))}
            >
              {tr("上一页")}
            </button>
            <button
              className="secondary"
              disabled={offset + 20 >= data.data.total}
              onClick={() => setOffset(offset + 20)}
            >
              {tr("下一页")}
            </button>
          </div>
        </div>
      )}
      {selected && (
        <Dialog title={tr("请求详情")} close={() => setSelected(undefined)}>
          <dl className="detail-grid">
            {Object.entries({
              "请求 ID": selected.id,
              ...(selected.parent_request_id
                ? {
                    调用类型: tr("流程内部调用"),
                    "父请求 ID": selected.parent_request_id,
                    流程节点: selected.workflow_node_id || "—",
                  }
                : {}),
              用户: selected.user_name || displayUser(selected.user_id),
              "API Key": displayKey(selected),
              "密钥 ID": selected.key_id || "—",
              模型: selected.model || "—",
              思考强度: selected.effort || "—",
              渠道: displayChannel(selected.upstream),
              消耗来源: consumptionLabel(selected.consumption_source),
              入口协议: selected.protocol,
              状态: names[selected.status],
              "HTTP 状态": selected.http_status,
              耗时: latency(selected.latency_ms),
              "首 Token 延迟": latency(selected.first_token_ms),
              "输入 Token": number(selected.input_tokens),
              "输出 Token": number(selected.output_tokens),
              "TPS（输出 / 总耗时）": number(selected.output_tps),
              "估算消耗 (USD)": money(
                selected.cost_micro_usd == null
                  ? null
                  : selected.cost_micro_usd / 1000000,
              ),
              "实际扣费 (USD)": money(
                selected.charged_micro_usd == null
                  ? null
                  : selected.charged_micro_usd / 1000000,
              ),
              "预留金额 (USD)": money(
                selected.held_micro_usd == null
                  ? null
                  : selected.held_micro_usd / 1000000,
              ),
              ...(selected.billing_status !== "settled"
                ? { 计费状态: billingStatus(selected.billing_status) }
                : {}),
              ...(selected.billing_note
                ? { 计费说明: billingNote(selected.billing_note) }
                : {}),
              错误代码: selected.error_code || "—",
            }).map(([k, v]) => (
              <div key={k}>
                <dt>{tr(k)}</dt>
                <dd>{v as React.ReactNode}</dd>
              </div>
            ))}
          </dl>
          {requestErrorHint(selected.error_code) && (
            <p className="field-note">
              {requestErrorHint(selected.error_code)}
            </p>
          )}
          {selected.billing_receipt && (
            <PriceReceiptView
              value={selected.billing_receipt}
              title={tr("实际扣费明细")}
            />
          )}
          <PriceReceiptView
            value={estimateReceipt(selected)}
            title={tr("费用估算明细")}
            showMultiplier={
              !["byoapi", "byosub", "personal"].includes(
                selected.consumption_source,
              )
            }
          />
          {(selected.routing || selected.upstream_response_model) && (
            <RoutingDetails
              value={selected.routing}
              requestedModel={selected.model}
              responseModel={selected.upstream_response_model}
            />
          )}
          <WorkflowCalls key={selected.id} host={host} parentId={selected.id} />
          {scope.data?.scope === "all" && (
            <a
              className="button secondary"
              href={"#/logs?requestId=" + encodeURIComponent(selected.id)}
            >
              {tr("查看关联运行日志")}
            </a>
          )}
        </Dialog>
      )}
    </>
  );
}
export const mount = (element: HTMLElement, host: UIHost) =>
  mountPage(element, host, Page);
