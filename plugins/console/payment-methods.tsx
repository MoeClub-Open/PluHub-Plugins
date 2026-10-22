import { t as tr, textValue } from "../../lib/ui/i18n.js";
import React from "react";
import type { Extension, UIHost, UIExtensionModule } from "@pluhub/ui-sdk";
import { Empty, Icon } from "../../lib/ui/components.js";
import { paymentAdapterSelection, paymentMethodsPath } from "./navigation.js";

export function PaymentMethods({
  adapters,
  hash,
  client,
  version,
}: {
  adapters: Extension[];
  hash: string;
  client: UIHost;
  version: number;
}) {
  const [query, setQuery] = React.useState("");
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const element = React.useRef<HTMLDivElement>(null);
  const selected = paymentAdapterSelection(adapters, hash);
  const requested = new URLSearchParams(hash.split("?")[1]).has("adapter");
  React.useEffect(() => {
    let canceled = false;
    let dispose: (() => void) | undefined;
    setError("");
    setLoading(!!selected);
    if (selected && element.current) {
      const target = element.current;
      void import(selected.url)
        .then((mod: UIExtensionModule) => {
          if (!canceled)
            dispose = mod.mount(target, { ...client, page: selected.path });
        })
        .catch((e) => {
          if (!canceled)
            setError(tr("支付方式加载失败：") + (e as Error).message);
        })
        .finally(() => {
          if (!canceled) setLoading(false);
        });
    }
    return () => {
      canceled = true;
      dispose?.();
    };
  }, [selected?.id, selected?.url, client, version]);
  const visible = adapters.filter((adapter) =>
    (adapter.title + " " + adapter.id)
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  if (selected)
    return (
      <>
        <div className="payment-method-toolbar">
          <a className="button secondary" href={"#" + paymentMethodsPath}>
            <Icon name="back" size={15} />
            {tr("全部支付方式")}
          </a>
          <span className="muted">{selected.title}</span>
        </div>
        {loading && <p role="status">{tr("正在加载配置…")}</p>}
        {error && (
          <div className="notice" role="alert">
            {error}
          </div>
        )}
        <div ref={element} key={selected.id} />
      </>
    );
  return (
    <>
      {requested && (
        <div className="notice" role="status">
          {tr("该支付适配器未启用或不存在，请重新选择。")}
        </div>
      )}
      <div className="payment-method-toolbar">
        <label className="payment-method-search">
          <Icon name="search" size={17} />
          <input
            type="search"
            aria-label={tr("搜索支付方式")}
            placeholder={tr("搜索名称…")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <span className="muted">
          {tr("{0} 种可配置方式", { "0": textValue(adapters.length) })}
        </span>
        <a className="button secondary" href="#/plugins">
          <Icon name="plus" size={15} />
          {tr("管理支付插件")}
        </a>
      </div>
      {visible.length ? (
        <div className="payment-method-list">
          {visible.map((adapter) => (
            <a
              className="payment-method-row"
              key={adapter.id}
              href={
                "#" +
                paymentMethodsPath +
                "?adapter=" +
                encodeURIComponent(adapter.id)
              }
            >
              <span className="payment-method-icon">
                <Icon name="money" size={21} />
              </span>
              <span className="payment-method-name">
                <strong>{adapter.title}</strong>
              </span>
              <span className="payment-method-action">
                {tr("配置")}
                <Icon name="arrow" size={15} />
              </span>
            </a>
          ))}
        </div>
      ) : (
        <Empty title={query ? tr("没有匹配的支付方式") : tr("尚无支付方式")}>
          {query ? (
            <button className="secondary" onClick={() => setQuery("")}>
              {tr("清除搜索")}
            </button>
          ) : (
            <a className="button secondary" href="#/plugins">
              {tr("管理插件")}
            </a>
          )}
        </Empty>
      )}
    </>
  );
}
