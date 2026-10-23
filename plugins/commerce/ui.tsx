import { t as tr, textValue, getLocale } from "../../lib/ui/i18n.js";
import { Select } from "../../lib/ui/select.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { mountPage, useLoad, Notice } from "../../lib/ui/mount.js";
import {
  PageHeading,
  Dialog,
  Icon,
  ListPagination,
} from "../../lib/ui/components.js";
import {
  supportsCheckout,
  paymentLabels,
  checkoutMethodKey,
  type CheckoutMethod,
} from "../../lib/commerce/checkout.js";
import { ProductSettings } from "./settings.js";
import { CommerceAdmin } from "./admin-ui.js";
import { PaymentAdjustmentsAdmin, OrderAdjustments } from "./adjustments-ui.js";
const api = "/api/plugins/official.commerce";
const price = (p: any) =>
  new Intl.NumberFormat(getLocale(), {
    style: "currency",
    currency: p.currency.toUpperCase(),
  }).format(p.paymentMinor / 100);
const states: Record<string, string> = {
  get pending() {
    return tr("待支付");
  },
  get paid() {
    return tr("已支付");
  },
  get failed() {
    return tr("支付失败");
  },
  get active() {
    return tr("生效中");
  },
  get cancel_at_period_end() {
    return tr("本期结束后不再续订");
  },
  get cancelled() {
    return tr("已取消续订");
  },
  get past_due() {
    return tr("续费逾期");
  },
};
function Page({ host }: { host: UIHost }) {
  const catalog = useLoad<any>(() => host.request(api + "/catalog")),
    subs = useLoad<any[]>(() => host.request(api + "/subscriptions"));
  const checkoutNonce = React.useRef<
    { key: string; value: string } | undefined
  >(undefined);
  const [methodKey, setMethodKey] = React.useState("");
  const [view, setView] = React.useState(
    new URLSearchParams(location.hash.split("?")[1]).has("order")
      ? "orders"
      : "plans",
  );
  const [busy, setBusy] = React.useState(false),
    [message, setMessage] = React.useState("");
  const [selected, setSelected] = React.useState<any>(),
    [cancelTarget, setCancelTarget] = React.useState<any>(),
    [adjustmentOrder, setAdjustmentOrder] = React.useState<any>();
  const [query, setQuery] = React.useState(""),
    [status, setStatus] = React.useState("all"),
    [page, setPage] = React.useState(1),
    [size, setSize] = React.useState(10);
  const methods: CheckoutMethod[] =
    catalog.data?.paymentMethods ??
    (catalog.data?.providers ?? []).map((provider: string) => ({
      provider,
      name: provider,
    }));
  const method = methods.find((m) => checkoutMethodKey(m) === methodKey);
  const provider = method?.provider ?? "";
  const methodLabel = method
    ? tr(paymentLabels[method.name] ?? method.name)
    : "";
  React.useEffect(() => {
    if (!method)
      setMethodKey(methods.length ? checkoutMethodKey(methods[0]!) : "");
  }, [catalog.data, methodKey]);
  const products = (catalog.data?.products ?? []).filter((p: any) =>
    supportsCheckout(provider, p.currency),
  );
  const [appliedQuery, setAppliedQuery] = React.useState("");
  React.useEffect(() => {
    const timer = setTimeout(() => setAppliedQuery(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);
  const orderQuery = new URLSearchParams({
    limit: String(size),
    offset: String((page - 1) * size),
    ...(appliedQuery ? { q: appliedQuery } : {}),
    ...(status !== "all" ? { status } : {}),
  });
  const orders = useLoad<{ items: any[]; total: number }>(
    () => host.request(api + "/orders/history?" + orderQuery),
    [appliedQuery, status, page, size],
  );
  const filtered = orders.data?.items ?? [];
  const current = page;
  function refresh() {
    catalog.reload();
    orders.reload();
    subs.reload();
  }
  return (
    <>
      <PageHeading title={tr("充值与订阅")}>
        {catalog.data?.customerPortal && (
          <button
            className="secondary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const result = await host.request<{ url: string }>(
                  api + "/customer-portal",
                  { method: "POST", body: "{}" },
                );
                location.assign(result.url);
              } catch (error) {
                setMessage((error as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {tr("管理付款方式与账单")}
          </button>
        )}
        <button
          className="secondary"
          aria-label={tr("刷新付款状态")}
          onClick={refresh}
        >
          <Icon name="refresh" size={15} />
          {tr("刷新")}
        </button>
      </PageHeading>
      {!selected && !cancelTarget && (
        <Notice
          message={message || catalog.error || orders.error || subs.error}
        />
      )}
      <div
        className="compact-tabs"
        role="tablist"
        aria-label={tr("充值与订阅功能")}
      >
        {[
          ["plans", tr("购买额度")],
          ["subscriptions", tr("我的订阅")],
          ["orders", tr("订单历史")],
        ].map(([id, title]) => (
          <button
            key={id}
            role="tab"
            aria-selected={view === id}
            className={view === id ? "active" : ""}
            onClick={() => setView(id!)}
          >
            {title}
            {id === "orders" && orders.data?.total
              ? ` (${orders.data.total})`
              : id === "subscriptions" && subs.data?.length
                ? ` (${subs.data.length})`
                : ""}
          </button>
        ))}
      </div>
      {view === "plans" && (
        <>
          {!catalog.data && !catalog.error ? (
            <p className="empty-inline" role="status">
              {tr("正在加载商品…")}
            </p>
          ) : !methods.length ? (
            <div className="quiet-empty">
              <h2>{tr("暂时无法在线充值")}</h2>
              <p>{tr("本站暂未开放在线付款，请稍后再试或联系站点支持。")}</p>
            </div>
          ) : (
            <>
              <div className="section-heading">
                <h2>{tr("可购买商品")}</h2>
                <label>
                  {tr("支付方式")}
                  <Select
                    value={methodKey}
                    onChange={(e) => {
                      setMethodKey(e.target.value);
                      setMessage("");
                    }}
                  >
                    {methods.map((m) => (
                      <option
                        key={checkoutMethodKey(m)}
                        value={checkoutMethodKey(m)}
                      >
                        {tr(paymentLabels[m.name] ?? m.name)}
                      </option>
                    ))}
                  </Select>
                </label>
              </div>
              <div className="plan-grid">
                {products.map((p: any) => (
                  <article className="card plan-card" key={p.id}>
                    <span className="badge">
                      {p.mode === "subscription"
                        ? provider === "stripe"
                          ? tr("自动续订")
                          : tr("预付周期")
                        : tr("单次支付")}
                    </span>
                    <h2>{p.name}</h2>
                    <strong className="plan-price">
                      {price(p)}
                      <small>
                        {p.mode === "subscription"
                          ? p.interval === "year"
                            ? tr(" / 年")
                            : tr(" / 月")
                          : ""}
                      </small>
                    </strong>
                    <p>
                      {tr("到账 $")}
                      {(p.creditMicros / 1000000).toFixed(2)}{" "}
                      {tr("USD 调用额度")}
                    </p>
                    <button
                      disabled={busy}
                      onClick={() => {
                        setSelected(p);
                        setMessage("");
                      }}
                    >
                      {tr("选择{0}", {
                        "0": textValue(
                          p.mode === "subscription" ? tr("套餐") : tr("额度"),
                        ),
                      })}
                    </button>
                  </article>
                ))}
              </div>
              {!products.length && (
                <p className="empty-inline">
                  {tr(
                    "当前支付方式暂无可购买商品，可选择其他支付方式或稍后再试。",
                  )}
                </p>
              )}
            </>
          )}
        </>
      )}
      {view === "subscriptions" && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{tr("套餐")}</th>
                <th>{tr("续费方式 / 金额")}</th>
                <th>{tr("状态")}</th>
                <th>{tr("本期结束")}</th>
                <th>{tr("操作")}</th>
              </tr>
            </thead>
            <tbody>
              {subs.data?.map((s) => (
                <tr key={s.id}>
                  <td>{s.product.name}</td>
                  <td>
                    {s.provider === "stripe" ? tr("自动续订") : tr("手动续费")}
                    <small>
                      {price(s.product)} /{" "}
                      {s.product.interval === "year" ? tr("年") : tr("月")}
                    </small>
                  </td>
                  <td>
                    {s.period_end <= Date.now() && s.status !== "past_due"
                      ? tr("本期已结束")
                      : (states[s.status] ?? s.status)}
                  </td>
                  <td>{new Date(s.period_end).toLocaleString(getLocale())}</td>
                  <td>
                    {s.provider === "stripe" &&
                    ["active", "past_due"].includes(s.status) ? (
                      <button
                        className="ghost danger"
                        disabled={busy}
                        onClick={() => {
                          setCancelTarget(s);
                          setMessage("");
                        }}
                      >
                        {tr("取消自动续订")}
                      </button>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!subs.data?.length && (
            <p className="empty-inline">
              {subs.data ? tr("暂无订阅") : tr("正在加载订阅…")}
            </p>
          )}
        </div>
      )}
      {view === "orders" && (
        <>
          <div className="list-toolbar">
            <input
              type="search"
              aria-label={tr("搜索订单")}
              placeholder={tr("搜索订单号或商品名称")}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
            />
            <Select
              aria-label={tr("筛选订单状态")}
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="all">{tr("全部状态")}</option>
              {["pending", "paid", "failed"].map((s) => (
                <option key={s} value={s}>
                  {states[s]}
                </option>
              ))}
            </Select>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{tr("创建时间")}</th>
                  <th>{tr("订单 / 商品")}</th>
                  <th>{tr("实付金额")}</th>
                  <th>{tr("支付方式")}</th>
                  <th>{tr("状态")}</th>
                  <th>{tr("操作")}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((o) => (
                  <tr key={o.id}>
                    <td>
                      {new Date(o.created_at).toLocaleString(getLocale())}
                    </td>
                    <td>
                      {o.product.name}
                      <small>{o.id}</small>
                    </td>
                    <td>{price(o.product)}</td>
                    <td>
                      {tr(
                        paymentLabels[o.payment_method_name ?? o.provider] ??
                          o.payment_method_name ??
                          o.provider,
                      )}
                    </td>
                    <td>
                      <span
                        className={
                          "badge " +
                          (o.status === "paid"
                            ? "ready"
                            : o.status === "failed"
                              ? "error"
                              : "")
                        }
                      >
                        {states[o.status] ?? o.status}
                      </span>
                    </td>
                    <td>
                      {o.adjustmentCount > 0 ? (
                        <button
                          className="ghost"
                          onClick={() => setAdjustmentOrder(o)}
                        >
                          {tr("退款与争议")}
                        </button>
                      ) : o.status === "pending" && o.checkout_url ? (
                        <a
                          className="text-link"
                          href={o.checkout_url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {tr("继续付款 ↗")}
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!filtered.length && (
              <p className="empty-inline">
                {orders.data
                  ? appliedQuery || status !== "all"
                    ? tr("没有匹配的订单，请调整筛选。")
                    : tr("暂无订单。")
                  : tr("正在加载订单…")}
              </p>
            )}
          </div>
          <ListPagination
            total={orders.data?.total ?? 0}
            page={current}
            size={size}
            setPage={setPage}
            setSize={setSize}
          />
        </>
      )}
      {adjustmentOrder && (
        <OrderAdjustments
          host={host}
          order={adjustmentOrder}
          close={() => setAdjustmentOrder(undefined)}
        />
      )}
      {selected && (
        <Dialog
          title={tr("确认购买")}
          close={() => {
            if (!busy) setSelected(undefined);
          }}
        >
          <Notice message={message} />
          <dl className="purchase-summary">
            <dt>{tr("商品")}</dt>
            <dd>{selected.name}</dd>
            <dt>{tr("支付方式")}</dt>
            <dd>{methodLabel}</dd>
            <dt>{tr("付款金额")}</dt>
            <dd>{price(selected)}</dd>
            <dt>{tr("到账额度")}</dt>
            <dd>${(selected.creditMicros / 1000000).toFixed(2)} USD</dd>
          </dl>
          <p>
            {selected.mode === "subscription"
              ? provider === "stripe"
                ? tr("按{0}自动续费，可在「我的订阅」中取消。", {
                    "0": textValue(
                      selected.interval === "year" ? tr("年") : tr("月"),
                    ),
                  })
                : tr("本次为预付周期套餐，到期后需手动购买，不会自动扣款。")
              : tr("本次为单次支付，不会自动续费。")}
          </p>
          <div className="form-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setSelected(undefined)}
            >
              {tr("返回选择")}
            </button>
            <button
              disabled={busy || !method}
              onClick={async () => {
                setBusy(true);
                setMessage("");
                try {
                  const key = methodKey + ":" + selected.id;
                  if (checkoutNonce.current?.key !== key)
                    checkoutNonce.current = { key, value: crypto.randomUUID() };
                  await host.request<any>(api + "/checkout", {
                    method: "POST",
                    headers: { "idempotency-key": checkoutNonce.current.value },
                    body: JSON.stringify({
                      productId: selected.id,
                      provider,
                      paymentMethod: method?.id,
                    }),
                  });
                  setMessage(
                    tr(
                      "订单已创建，可在订单历史中继续付款。付款后请刷新查看到账结果。",
                    ),
                  );
                  checkoutNonce.current = undefined;
                  setSelected(undefined);
                  setView("orders");
                  orders.reload();
                } catch (error) {
                  setMessage((error as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? tr("创建订单中…") : tr("确认并创建订单")}
            </button>
          </div>
        </Dialog>
      )}
      {cancelTarget && (
        <Dialog
          title={tr("取消自动续订")}
          close={() => {
            if (!busy) setCancelTarget(undefined);
          }}
        >
          <Notice message={message} />
          <p>
            {tr("确定取消「")}
            {cancelTarget.product.name}
            {tr("」的自动续订？当前已付权益保留至")}{" "}
            {new Date(cancelTarget.period_end).toLocaleString(getLocale())}
            {tr("，之后不再自动扣款。")}
          </p>
          <div className="form-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setCancelTarget(undefined)}
            >
              {tr("保留订阅")}
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await host.request(api + "/cancel", {
                    method: "POST",
                    body: JSON.stringify({ id: cancelTarget.id }),
                  });
                  setMessage(
                    tr("已取消自动续订，已付权益保留至 ") +
                      new Date(cancelTarget.period_end).toLocaleString(
                        getLocale(),
                      ) +
                      "。",
                  );
                  setCancelTarget(undefined);
                  subs.reload();
                } catch (error) {
                  setMessage((error as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? tr("处理中…") : tr("确认取消续订")}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
function Settings({ host }: { host: UIHost }) {
  const [view, setView] = React.useState(
    new URLSearchParams(location.hash.split("?")[1]).has("userId")
      ? "orders"
      : "products",
  );
  return (
    <>
      <div className="tabs" role="tablist" aria-label={tr("商业管理")}>
        {[
          ["products", tr("商品配置")],
          ["orders", tr("全站订单")],
          ["subscriptions", tr("全站订阅")],
          ["outbox", tr("支付入账")],
          ["adjustments", tr("退款与争议")],
        ].map(([id, title]) => (
          <button
            key={id}
            role="tab"
            aria-selected={view === id}
            className={view === id ? "active" : ""}
            onClick={() => setView(id!)}
          >
            {title}
          </button>
        ))}
      </div>
      {view === "products" ? (
        <ProductSettings host={host} onSave={() => {}} />
      ) : view === "adjustments" ? (
        <PaymentAdjustmentsAdmin host={host} />
      ) : (
        <CommerceAdmin
          key={view}
          host={host}
          view={view as "orders" | "subscriptions" | "outbox"}
        />
      )}
    </>
  );
}
export const mount = (el: HTMLElement, host: UIHost) =>
  mountPage(el, host, host.page === "/settings/commerce" ? Settings : Page);
