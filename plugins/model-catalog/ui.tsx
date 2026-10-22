import { t as tr, textValue, getLocale } from "../../lib/ui/i18n.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import type { CatalogModel } from "@pluhub/contracts/ai";
import { Select } from "../../lib/ui/select.js";
import { mountPage, useLoad } from "../../lib/ui/mount.js";
import { PriceQuote } from "./quote-ui.js";
import {
  PageHeading,
  Icon,
  Empty,
  Dialog,
  number,
} from "../../lib/ui/components.js";

const price = (value?: number) =>
  value === undefined
    ? tr("暂未公布")
    : value === 0
      ? tr("免费")
      : "$" +
        new Intl.NumberFormat(getLocale(), {
          maximumSignificantDigits: 8,
        }).format(value);
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
  const [channel, setChannel] = React.useState("");
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
        (!provider || model.provider === provider) &&
        (
          model.name +
          " " +
          model.id +
          " " +
          model.provider +
          " " +
          model.description
        )
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
    )
    .sort((a, b) =>
      sort === "price"
        ? (a.inputPrice ?? Infinity) - (b.inputPrice ?? Infinity)
        : a.name.localeCompare(b.name),
    );
  const playPath = (model?: CatalogModel) =>
    "/playground" +
    (model
      ? "?model=" +
        encodeURIComponent(model.id) +
        (!guest && channel ? "&channel=" + encodeURIComponent(channel) : "")
      : "");
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
        {!guest && (
          <Select
            aria-label={tr("模型目录渠道")}
            value={channel}
            onChange={(event) => {
              setChannel(event.target.value);
              setProvider("");
              setSelected(undefined);
            }}
          >
            <option value="">{tr("平台模型")}</option>
            {channels.data?.map((item) => (
              <option key={item.id} value={item.id}>
                {item.scope === "personal" ? tr("个人 · ") : tr("平台 · ")}
                {item.name}
              </option>
            ))}
          </Select>
        )}
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
        <span>{tr("模型原价 · 美元 / 百万 Token")}</span>
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
              }}
            >
              {tr("清除筛选")}
            </button>
          )}
        </Empty>
      ) : (
        <div className="catalog-list">
          <div className="catalog-list-head" aria-hidden="true">
            <span>{tr("模型")}</span>
            <span>{tr("能力")}</span>
            <span>{tr("价格 / 百万 Token")}</span>
            <span>{tr("操作")}</span>
          </div>
          {models.map((model) => (
            <article className="model-row" key={model.id}>
              <div className="model-row-main">
                <span className="provider-mark" aria-hidden="true">
                  {model.provider.slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <h2 title={model.name}>{model.name}</h2>
                  <small>
                    <span>{model.provider}</span>
                    <code>{model.id}</code>
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
                <div>
                  <strong>
                    {price(
                      model.pricing?.mode === "request"
                        ? model.pricing.request
                        : model.inputPrice,
                    )}
                  </strong>
                  <span>
                    {model.pricing?.mode === "request"
                      ? tr("USD / 次")
                      : tr("输入")}
                  </span>
                </div>
                {model.pricing?.mode !== "request" && (
                  <div>
                    <strong>{price(model.outputPrice)}</strong>
                    <span>{tr("输出")}</span>
                  </div>
                )}
                {model.contextWindow && (
                  <div>
                    <strong>{number(model.contextWindow)}</strong>
                    <span>{tr("上下文")}</span>
                  </div>
                )}
              </div>
              <div className="model-row-actions">
                <button className="ghost" onClick={() => setSelected(model)}>
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
      )}
      {selected && (
        <Dialog title={selected.name} close={() => setSelected(undefined)}>
          <div className="catalog-detail">
            {selected.description && <p>{selected.description}</p>}
            <dl className="catalog-detail-facts">
              <div>
                <dt>{tr("提供商")}</dt>
                <dd>{selected.provider}</dd>
              </div>
              {selected.pricing?.mode !== "request" && (
                <div>
                  <dt>{tr("输入原价 / 百万 Token")}</dt>
                  <dd>{price(selected.inputPrice)}</dd>
                </div>
              )}
              {selected.pricing?.mode !== "request" && (
                <div>
                  <dt>{tr("输出原价 / 百万 Token")}</dt>
                  <dd>{price(selected.outputPrice)}</dd>
                </div>
              )}
              {selected.contextWindow && (
                <div>
                  <dt>{tr("上下文长度")}</dt>
                  <dd>{number(selected.contextWindow)}</dd>
                </div>
              )}
            </dl>
            {selected.pricing && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{tr("计价项目")}</th>
                      <th>{tr("原价 · USD")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.pricing.mode === "request" ? (
                      <tr>
                        <td>{tr("每次请求")}</td>
                        <td>{price(selected.pricing.request)}</td>
                      </tr>
                    ) : (
                      <>
                        {(
                          [
                            [tr("缓存读取"), selected.pricing.cacheRead],
                            [
                              tr("缓存写入 · 5 分钟"),
                              selected.pricing.cacheWrite,
                            ],
                            [
                              tr("缓存写入 · 1 小时"),
                              selected.pricing.cacheWrite1h,
                            ],
                          ] as const
                        )
                          .filter(([, value]) => value !== undefined)
                          .map(([name, value]) => (
                            <tr key={name}>
                              <td>{name} / 1M</td>
                              <td>{price(value)}</td>
                            </tr>
                          ))}
                        {selected.pricing.tiers?.map((tier) => (
                          <tr key={tier.above}>
                            <td>
                              {tr("输入 Token 超过")} {number(tier.above)}
                            </td>
                            <td>
                              {price(tier.input)} / {price(tier.output)} / 1M
                            </td>
                          </tr>
                        ))}
                      </>
                    )}
                  </tbody>
                </table>
              </div>
            )}
            {(selected.consumptionMultiplier ?? 1) !== 1 && (
              <p>
                {tr("渠道消耗倍率")} ×{selected.consumptionMultiplier}
              </p>
            )}
            {!guest &&
              !channel.startsWith("personal:") &&
              (selected.pricing?.mode === "request" ||
                (selected.inputPrice !== undefined &&
                  selected.outputPrice !== undefined)) && (
                <PriceQuote
                  key={channel + ":" + selected.id}
                  host={host}
                  model={selected.id}
                  channelId={channel || undefined}
                  requestPriced={selected.pricing?.mode === "request"}
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
