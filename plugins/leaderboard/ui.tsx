import { t as tr, textValue, getLocale } from "../../lib/ui/i18n.js";
import React from "react";
import type { CatalogModel } from "@pluhub/contracts/ai";
import { ModelLogo } from "../../lib/ui/model-logo.js";
import { RankingTable } from "./ranking-table.js";
import { Prices } from "./prices.js";
import type { UIHost } from "@pluhub/ui-sdk";
import type {
  Leaderboard,
  RankingKind,
  RankingMetric,
  RankingRange,
} from "@pluhub/contracts/analytics";
import { mountPage, Notice } from "../../lib/ui/mount.js";
import { Select } from "../../lib/ui/select.js";
import { Empty, Icon, PageHeading, number } from "../../lib/ui/components.js";
import { styles } from "./ui-style.js";

const exactNumber = (value: number) => value.toLocaleString(getLocale());
const date = (value: number) =>
  new Date(value).toLocaleDateString(getLocale(), { timeZone: "UTC" });

function Page({ host }: { host: UIHost }) {
  const [view, setView] = React.useState<"models" | "prices" | "users">(
    "models",
  );
  const kind: RankingKind = view === "users" ? "users" : "models";
  const [query, setQuery] = React.useState("");
  const [provider, setProvider] = React.useState("");
  const [catalog, setCatalog] = React.useState<CatalogModel[]>([]);
  const [catalogError, setCatalogError] = React.useState("");
  const [catalogBusy, setCatalogBusy] = React.useState(true);
  const [copyStatus, setCopyStatus] = React.useState("");
  const [range, setRange] = React.useState<RankingRange>("7d");
  const [metric, setMetric] = React.useState<RankingMetric>("tokens");
  const [version, setVersion] = React.useState(0);
  const [data, setData] = React.useState<Leaderboard>();
  const [busy, setBusy] = React.useState(true);
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    const controller = new AbortController();
    setCatalogBusy(true);
    setCatalogError("");
    void host
      .request<CatalogModel[]>("/api/plugins/official.leaderboard/prices", {
        signal: controller.signal,
      })
      .then((value) => {
        if (!controller.signal.aborted) setCatalog(value);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setCatalogError(failure.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setCatalogBusy(false);
      });
    return () => controller.abort();
  }, [host, version]);
  React.useEffect(() => {
    if (!copyStatus) return;
    const timer = setTimeout(() => setCopyStatus(""), 2500);
    return () => clearTimeout(timer);
  }, [copyStatus]);
  const copy = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id);
      setCopyStatus(tr("已复制模型 ID"));
    } catch {
      setCopyStatus(tr("复制失败，请手动复制"));
    }
  };
  React.useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError("");
    const query = new URLSearchParams({ kind, range, metric });
    void host
      .request<Leaderboard>(
        "/api/plugins/official.leaderboard/rankings?" + query,
        { signal: controller.signal },
      )
      .then((value) => {
        if (!controller.signal.aborted) setData(value);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(failure.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [host, kind, range, metric, version]);
  const current =
    data?.kind === kind && data.range === range && data.metric === metric
      ? data
      : undefined;
  const matches = (row: {
    name: string;
    modelId?: string;
    provider?: string;
  }) =>
    (!provider || row.provider === provider) &&
    (!query.trim() ||
      [row.name, row.modelId, row.provider].some((value) =>
        value?.toLowerCase().includes(query.trim().toLowerCase()),
      ));
  const rows = current?.rows.filter(matches) ?? [];
  const providers = [
    ...new Set(
      (view === "prices" ? catalog : (current?.rows ?? []))
        .map((row) => row.provider)
        .filter((value): value is string => !!value),
    ),
  ].sort();
  const changeView = (next: typeof view) => {
    setView(next);
    setQuery("");
    setProvider("");
  };
  return (
    <div className="leaderboard">
      <style>{styles}</style>
      <PageHeading title={tr("排行榜")}>
        {view !== "prices" && (
          <>
            <Select
              aria-label={tr("排行榜时间范围")}
              value={range}
              onChange={(event) => setRange(event.target.value as RankingRange)}
            >
              <option value="7d">{tr("近 7 天")}</option>
              <option value="30d">{tr("近 30 天")}</option>
              <option value="all">{tr("累计")}</option>
            </Select>
            <Select
              aria-label={tr("排行榜排序")}
              value={metric}
              onChange={(event) =>
                setMetric(event.target.value as RankingMetric)
              }
            >
              <option value="tokens">{tr("按 Token 用量")}</option>
              <option value="requests">{tr("按调用次数")}</option>
            </Select>
          </>
        )}
        <button
          className="secondary icon-button"
          aria-label={tr("刷新排行榜")}
          title={tr("刷新排行榜")}
          disabled={view === "prices" ? catalogBusy : busy}
          onClick={() => setVersion((value) => value + 1)}
        >
          <Icon name="refresh" size={16} />
        </button>
      </PageHeading>
      <div
        className="leaderboard-tabs"
        role="tablist"
        aria-label={tr("排行榜分类")}
      >
        {(["models", "prices", "users"] as const).map((tab) => (
          <button
            key={tab}
            role="tab"
            id={"leaderboard-tab-" + tab}
            aria-controls="leaderboard-panel"
            aria-selected={view === tab}
            tabIndex={view === tab ? 0 : -1}
            className={view === tab ? "active" : ""}
            onClick={() => changeView(tab)}
            onKeyDown={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              )
                return;
              event.preventDefault();
              const tabs = ["models", "prices", "users"] as const;
              const index = tabs.indexOf(view);
              const next =
                tabs[
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? 2
                      : (index + (event.key === "ArrowRight" ? 1 : 2)) % 3
                ];
              changeView(next);
              event.currentTarget.parentElement
                ?.querySelector<HTMLButtonElement>("#leaderboard-tab-" + next)
                ?.focus();
            }}
          >
            <Icon
              name={
                tab === "users"
                  ? "users"
                  : tab === "prices"
                    ? "money"
                    : "models"
              }
              size={16}
            />
            {tab === "users"
              ? tr("用户排行")
              : tab === "prices"
                ? tr("价格排行")
                : tr("模型排行")}
          </button>
        ))}
      </div>
      <Notice message={view === "prices" ? catalogError : error} />
      <span className="leaderboard-copy-status" role="status">
        {copyStatus}
      </span>
      <section
        id="leaderboard-panel"
        role="tabpanel"
        aria-labelledby={"leaderboard-tab-" + view}
        aria-busy={view === "prices" ? catalogBusy : busy}
      >
        {view !== "users" && (
          <div className="leaderboard-filters">
            <label className="leaderboard-search">
              <Icon name="search" size={16} />
              <input
                aria-label={tr("搜索模型")}
                placeholder={tr("搜索模型名称或 ID")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                type="search"
              />
            </label>
            <Select
              aria-label={tr("提供商")}
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
            >
              <option value="">{tr("全部提供商")}</option>
              {providers.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </div>
        )}
        {view === "prices" ? (
          <Prices
            models={catalog.filter((model) =>
              matches({ ...model, modelId: model.id }),
            )}
            busy={catalogBusy}
            error={catalogError}
            copy={copy}
          />
        ) : (
          <>
            <div className="leaderboard-summary">
              <div>
                <span>{tr("Token 用量")}</span>
                <strong title={current && exactNumber(current.totals.tokens)}>
                  {current ? number(current.totals.tokens) : "—"}
                </strong>
              </div>
              <div>
                <span>{tr("成功调用")}</span>
                <strong>
                  {current ? number(current.totals.requests) : "—"}
                </strong>
              </div>
              <div>
                <span>
                  {kind === "users" ? tr("参与用户") : tr("活跃模型")}
                </span>
                <strong>
                  {current ? number(current.totals.participants) : "—"}
                </strong>
              </div>
              {kind === "users" && (
                <div className="leaderboard-my-summary">
                  <span>{tr("我的排名")}</span>
                  <strong>{current?.me ? "#" + current.me.rank : "—"}</strong>
                </div>
              )}
            </div>
            {kind === "models" && rows.length > 0 && (
              <div
                className="leaderboard-chart"
                aria-label={tr("模型用量占比")}
              >
                {rows.slice(0, 5).map((row) => (
                  <div className="leaderboard-chart-row" key={row.modelId}>
                    <span title={row.name}>
                      <ModelLogo
                        model={row.modelId ?? row.name}
                        provider={row.provider ?? ""}
                      />
                      {row.name}
                    </span>
                    <div className="leaderboard-chart-track">
                      <i
                        style={{
                          width:
                            (rows[0].share
                              ? (row.share / rows[0].share) * 100
                              : 0) + "%",
                        }}
                      />
                    </div>
                    <strong>{(row.share * 100).toFixed(1)}%</strong>
                  </div>
                ))}
              </div>
            )}
            {rows.length ? (
              <RankingTable
                rows={rows}
                current={current}
                kind={kind}
                metric={metric}
                copy={copy}
              />
            ) : (
              <div role="status">
                <Empty
                  title={
                    busy
                      ? tr("正在加载排行榜…")
                      : error
                        ? tr("排行榜暂不可用")
                        : query || provider
                          ? tr("没有匹配的模型")
                          : tr("这个时段还没有排名")
                  }
                />
              </div>
            )}
            {current && (
              <div className="leaderboard-footnote">
                <span
                  title={tr(
                    "按 UTC 自然日汇总；Token 使用上游返回的实际用量。未返回用量的成功请求仅计调用次数。",
                  )}
                >
                  {date(current.from)} — {date(current.updatedAt)} · UTC
                </span>
                <span>
                  {tr("前 {0} 名", { "0": textValue(current.limit) })}
                </span>
                {current.totals.usageRequests < current.totals.requests && (
                  <span
                    title={tr(
                      "部分上游未返回 Token 用量，这些请求不会估算或填入 Token。",
                    )}
                  >
                    {number(current.totals.usageRequests)} {tr("次调用有用量")}
                  </span>
                )}
                {range === "all" && (
                  <span
                    title={tr(
                      "从保留的历史调用回填，之后持续累计；升级前已清理的日志无法恢复。",
                    )}
                  >
                    {tr("统计始于")}
                    {date(current.coverageSince)}
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
export const mount = (element: HTMLElement, host: UIHost) =>
  mountPage(element, host, Page);
