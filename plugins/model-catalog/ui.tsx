import { t as tr, textValue } from "../../lib/ui/i18n.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import type { CatalogModel } from "@pluhub/contracts/ai";
import { Select } from "../../lib/ui/select.js";
import { mountPage, useLoad } from "../../lib/ui/mount.js";
import { PriceQuote } from "./quote-ui.js";
import { ModelLogo } from "../../lib/ui/model-logo.js";
import {
  consumptionPrice,
  formatPrice as price,
  ModelPrices,
} from "./prices.js";
import {
  PageHeading,
  Icon,
  Empty,
  Dialog,
  number,
  latency,
} from "../../lib/ui/components.js";

const featureNames: Record<string, string> = {
  get text() {
    return tr("文本对话");
  },
  get tools() {
    return tr("工具调用");
  },
  get stream() {
    return tr("流式回复");
  },
};
function Page({ host }: { host: UIHost }) {
  const guest = host.authenticated === false;
  const [channel, setChannel] = React.useState(
    new URLSearchParams(location.hash.split("?")[1]).get("channel") ?? "",
  );
  const channels = useLoad<any[]>(
    () =>
      guest
        ? Promise.resolve([])
        : host
            .request("/api/plugins/official.ai-router/channels")
            .catch(() => []),
    [guest],
  );
  const loaded = useLoad<CatalogModel[]>(
    () =>
      host.request(
        guest
          ? "/api/plugins/official.model-catalog/public"
          : "/api/plugins/official.model-catalog/models?channel=" +
              encodeURIComponent(channel),
      ),
    [channel, guest],
  );
  const [search, setSearch] = React.useState("");
  const [provider, setProvider] = React.useState("");
  const [sort, setSort] = React.useState("name");
  const [selected, setSelected] = React.useState<CatalogModel>();
  const providers = [...new Set(loaded.data?.map((model) => model.provider))];
  const models = (loaded.data ?? [])
    .filter(
      (model) =>
        (!channel || model.channel?.id === channel) &&
        (!provider || model.provider === provider) &&
        (
          model.name +
          " " +
          model.id +
          " " +
          model.provider +
          " " +
          model.description +
          " " +
          (model.channel?.name ?? "")
        )
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
    )
    .sort((a, b) =>
      sort === "price"
        ? (consumptionPrice(
            a,
            a.pricing?.mode === "request" ? "request" : "input",
          ) ?? Infinity) -
          (consumptionPrice(
            b,
            b.pricing?.mode === "request" ? "request" : "input",
          ) ?? Infinity)
        : a.name.localeCompare(b.name),
    );
  const channelOptions = guest
    ? [
        ...new Map(
          (loaded.data ?? [])
            .filter((m) => m.channel)
            .map((m) => [
              m.channel!.id,
              { ...m.channel!, consumptionMultiplier: m.consumptionMultiplier },
            ]),
        ).values(),
      ]
    : (channels.data ?? []);
  const groups = [
    ...new Set(models.map((model) => model.channel?.id ?? "")),
  ].map((id) => ({
    id,
    models: models.filter((model) => (model.channel?.id ?? "") === id),
  }));
  const playPath = (model?: CatalogModel) => {
    const params = new URLSearchParams();
    if (model) params.set("model", model.id);
    const chosen = model?.channel?.id ?? channel;
    if (chosen) params.set("channel", chosen);
    return "/playground" + (params.size ? "?" + params : "");
  };
  const destination = (model?: CatalogModel) =>
    guest
      ? "/login?next=" + encodeURIComponent(playPath(model))
      : playPath(model);
  const snippet = (model: CatalogModel) =>
    `curl ${location.origin}/v1/chat/completions \\\n  -H "Authorization: Bearer $PLUHUB_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify({ model: model.id, messages: [{ role: "user", content: "Hello" }], stream: true })}'`;
  return (
    <div className="model-directory">
      <PageHeading title={tr("模型目录")}>
        <a className="button secondary" href={"#" + destination()}>
          <Icon name="chat" size={16} />
          {tr("在线对话")}
        </a>
      </PageHeading>

      <div className="toolbar catalog-toolbar">
        <Select
          aria-label={tr("模型目录渠道")}
          value={channel}
          onChange={(event) => {
            setChannel(event.target.value);
            setProvider("");
            setSelected(undefined);
          }}
        >
          <option value="">{tr("全部渠道")}</option>
          {channelOptions.map((item) => (
            <option key={item.id} value={item.id}>
              {item.scope === "personal" ? tr("个人 · ") : ""}
              {item.name} · ×{item.consumptionMultiplier ?? 1}
            </option>
          ))}
        </Select>
        <div className="search-box">
          <Icon name="search" />
          <input
            aria-label={tr("搜索模型")}
            placeholder={tr("搜索模型名称、提供商或用途…")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <Select
          aria-label={tr("筛选供应商")}
          value={provider}
          onChange={(event) => setProvider(event.target.value)}
        >
          <option value="">{tr("所有提供商")}</option>
          {providers.map((item) => (
            <option key={item}>{item}</option>
          ))}
        </Select>
        <Select
          aria-label={tr("模型排序")}
          value={sort}
          onChange={(event) => setSort(event.target.value)}
        >
          <option value="name">{tr("按名称排序")}</option>
          <option value="price">{tr("输入价格从低到高")}</option>
        </Select>
      </div>
      {loaded.error && (
        <div className="notice" role="alert">
          {tr("模型目录暂时无法加载。")}
          <button className="ghost" onClick={loaded.reload}>
            {tr("重新加载")}
          </button>
        </div>
      )}
      <div className="catalog-summary">
        <span role="status">
          {loaded.data
            ? tr("{0} 个模型", { "0": textValue(models.length) })
            : loaded.error
              ? tr("加载失败")
              : tr("正在加载模型…")}
        </span>
        <span>{tr("扣费价格 · 美元 / 百万 Token")}</span>
      </div>
      {loaded.data && models.length === 0 ? (
        <Empty
          title={
            loaded.data.length ? tr("没有找到匹配的模型") : tr("模型正在准备中")
          }
        >
          {loaded.data.length > 0 && (
            <button
              className="secondary"
              onClick={() => {
                setSearch("");
                setProvider("");
                setChannel("");
              }}
            >
              {tr("清除筛选")}
            </button>
          )}
        </Empty>
      ) : (
        <div className="catalog-channel-list">
          {groups.map((group) => (
            <section className="catalog-channel" key={group.id}>
              <div className="section-heading catalog-channel-heading">
                <h2>{group.models[0]?.channel?.name ?? tr("平台模型")}</h2>
                <span className="feature-pill">
                  {tr("渠道消耗倍率")} ×
                  {group.models[0]?.consumptionMultiplier ?? 1}
                </span>
                <span className="muted">
                  {tr("{0} 个模型", { "0": textValue(group.models.length) })}
                </span>
              </div>
              <div className="catalog-list">
                <div className="catalog-list-head" aria-hidden="true">
                  <span>{tr("模型")}</span>
                  <span>{tr("能力")}</span>
                  <span>{tr("扣费价格 / 百万 Token")}</span>
                  <span>{tr("操作")}</span>
                </div>
                {group.models.map((model) => (
                  <article
                    className="model-row"
                    key={model.channel?.id + ":" + model.id}
                  >
                    <div className="model-row-main">
                      <ModelLogo model={model.id} provider={model.provider} />
                      <div>
                        <h2 title={model.name}>{model.name}</h2>
                        <small>
                          <span>{model.provider}</span>
                          {model.name !== model.id && <code>{model.id}</code>}
                        </small>
                      </div>
                    </div>
                    <div className="model-row-features">
                      {model.features
                        .filter((feature) => featureNames[feature])
                        .map((feature) => (
                          <span className="feature-pill" key={feature}>
                            {featureNames[feature]}
                          </span>
                        ))}
                    </div>
                    <div className="model-row-prices">
                      {model.pricing?.mode === "expression" ? (
                        <div>
                          <strong>{tr("动态定价")}</strong>
                        </div>
                      ) : (
                        <>
                          <div>
                            <strong>
                              {price(
                                consumptionPrice(
                                  model,
                                  model.pricing?.mode === "request"
                                    ? "request"
                                    : "input",
                                ),
                              )}
                            </strong>
                            {consumptionPrice(
                              model,
                              model.pricing?.mode === "request"
                                ? "request"
                                : "input",
                            ) !==
                              (model.pricing?.mode === "request"
                                ? model.pricing.request
                                : model.inputPrice) && (
                              <del title={tr("原价")}>
                                {price(
                                  model.pricing?.mode === "request"
                                    ? model.pricing.request
                                    : model.inputPrice,
                                )}
                              </del>
                            )}
                            <span>
                              {model.pricing?.mode === "request"
                                ? tr("USD / 次")
                                : tr("输入")}
                            </span>
                          </div>
                          {model.pricing?.mode !== "request" && (
                            <div>
                              <strong>
                                {price(consumptionPrice(model, "output"))}
                              </strong>
                              {consumptionPrice(model, "output") !==
                                model.outputPrice && (
                                <del title={tr("原价")}>
                                  {price(model.outputPrice)}
                                </del>
                              )}
                              <span>{tr("输出")}</span>
                            </div>
                          )}
                        </>
                      )}
                      {model.contextWindow && (
                        <div>
                          <strong>{number(model.contextWindow)}</strong>
                          <span>{tr("上下文")}</span>
                        </div>
                      )}
                    </div>
                    <div className="model-row-actions">
                      <button
                        className="ghost"
                        onClick={() => setSelected(model)}
                      >
                        {tr("详情")}
                      </button>
                      <button
                        className="secondary"
                        onClick={() => host.navigate(destination(model))}
                      >
                        {tr("使用")}
                        <Icon name="arrow" size={14} />
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      {selected && (
        <Dialog title={selected.name} close={() => setSelected(undefined)}>
          <div className="catalog-detail">
            <div className="catalog-model-heading">
              <ModelLogo model={selected.id} provider={selected.provider} />
              <code>{selected.id}</code>
            </div>
            {selected.description && <p>{selected.description}</p>}
            <dl className="catalog-detail-facts">
              <div>
                <dt>{tr("提供商")}</dt>
                <dd>{selected.provider}</dd>
              </div>
              <div>
                <dt>{tr("渠道")}</dt>
                <dd>{selected.channel?.name ?? tr("平台模型")}</dd>
              </div>
              <div>
                <dt>{tr("渠道消耗倍率")}</dt>
                <dd>×{selected.consumptionMultiplier ?? 1}</dd>
              </div>
              {selected.contextWindow && (
                <div>
                  <dt>{tr("上下文长度")}</dt>
                  <dd>{number(selected.contextWindow)}</dd>
                </div>
              )}
            </dl>
            <h3>{tr("近 24 小时")}</h3>
            <dl className="catalog-detail-facts">
              <div>
                <dt>{tr("平均延迟")}</dt>
                <dd>{latency(selected.metrics?.avgLatencyMs)}</dd>
              </div>
              <div>
                <dt>{tr("首 Token 延迟")}</dt>
                <dd>{latency(selected.metrics?.avgFirstTokenMs)}</dd>
              </div>
              <div
                title={tr("可见输出 Token / 内容流持续时间；{0} 个样本", {
                  "0": textValue(selected.metrics?.streamSamples ?? 0),
                })}
              >
                <dt>{tr("输出速度")}</dt>
                <dd>
                  {selected.metrics?.outputTps === undefined
                    ? "—"
                    : number(selected.metrics.outputTps) + " TPS"}
                </dd>
              </div>
              <div
                title={tr(
                  "已报告缓存用量的成功请求中，发生缓存命中的比例；{0} 个样本",
                  { "0": textValue(selected.metrics?.cacheSamples ?? 0) },
                )}
              >
                <dt>{tr("缓存命中率")}</dt>
                <dd>
                  {selected.metrics?.cacheHitRate === undefined
                    ? "—"
                    : number(selected.metrics.cacheHitRate * 100) + "%"}
                </dd>
              </div>
              <div>
                <dt>{tr("成功率")}</dt>
                <dd>
                  {selected.metrics?.requests
                    ? number(
                        (selected.metrics.successes /
                          selected.metrics.requests) *
                          100,
                      ) + "%"
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>{tr("请求数")}</dt>
                <dd>
                  {selected.metrics ? number(selected.metrics.requests) : "—"}
                </dd>
              </div>
            </dl>
            <ModelPrices model={selected} />
            {!guest &&
              selected.channel?.scope !== "personal" &&
              (["request", "expression"].includes(
                selected.pricing?.mode ?? "tokens",
              ) ||
                (selected.inputPrice !== undefined &&
                  selected.outputPrice !== undefined)) && (
                <PriceQuote
                  key={selected.channel?.id + ":" + selected.id}
                  host={host}
                  model={selected.id}
                  channelId={selected.channel?.id ?? (channel || undefined)}
                  requestPriced={selected.pricing?.mode === "request"}
                  expression={selected.pricing?.expression}
                />
              )}
            <details className="catalog-api-example">
              <summary>{tr("开发者接入")}</summary>
              <p>
                {tr("API 地址：")}
                <code>{location.origin}/v1</code>
              </p>
              <pre>
                <code>{snippet(selected)}</code>
              </pre>
            </details>
          </div>
          <div className="modal-actions">
            {!guest && (
              <button
                className="secondary"
                onClick={() => host.navigate("/auth")}
              >
                {tr("管理 API Key")}
              </button>
            )}
            <button onClick={() => host.navigate(destination(selected))}>
              {guest ? tr("登录并开始对话") : tr("开始对话")}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
export const mount = (element: HTMLElement, host: UIHost) =>
  mountPage(element, host, Page);
