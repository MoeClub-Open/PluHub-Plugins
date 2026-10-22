import { t as tr, getLocale, textValue } from "../../lib/ui/i18n.js";
import { Select } from "../../lib/ui/select.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { useLoad, Notice } from "../../lib/ui/mount.js";
import { Dialog, PageHeading } from "../../lib/ui/components.js";
import { usdToMicros } from "../../lib/commerce/decimal.js";
import { nextNumericId } from "../../lib/numeric-id.js";

type Product = {
  id: string;
  name: string;
  mode: "payment" | "subscription";
  interval: "month" | "year";
  currency: string;
  paymentMinor: number;
  creditMicros: number;
};

export function ProductSettings({
  host,
  onSave,
}: {
  host: UIHost;
  onSave: () => void;
}) {
  const data = useLoad<any>(() => host.request("/api/host/config"));
  const [editing, setEditing] = React.useState<Partial<Product>>();
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [removing, setRemoving] = React.useState<Product>();
  const find = (c: any) =>
    c.plugins.find((p: any) =>
      /\/(?:official\.)?commerce$/.test(p.path.replaceAll("\\", "/")),
    );
  const settings = data.data ? (find(data.data)?.config ?? {}) : {};
  const products: Product[] = settings.products ?? [];
  const price = (product: Product) =>
    new Intl.NumberFormat(getLocale(), {
      style: "currency",
      currency: product.currency.toUpperCase(),
    }).format(product.paymentMinor / 100);
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const f = new FormData(e.currentTarget);
    try {
      const config = await host.request<any>("/api/host/config");
      const plugin = find(config);
      const paymentMicros = usdToMicros(String(f.get("payment")));
      if (paymentMicros < 10000 || paymentMicros % 10000)
        throw new Error(tr("支付金额必须为正数且最多两位小数"));
      const productId =
        editing?.id ??
        nextNumericId(
          (plugin.config.products ?? []).map((product: any) => product.id),
          plugin.config.nextProductId,
        );
      const mode = String(f.get("mode")) as Product["mode"];
      const product = {
        id: productId,
        name: String(f.get("name")),
        mode,
        interval:
          mode === "subscription" ? String(f.get("interval")) : "month",
        currency: String(f.get("currency")),
        paymentMinor: paymentMicros / 10000,
        creditMicros: usdToMicros(String(f.get("credit"))),
      };
      const next = [...(plugin.config.products ?? [])];
      const i = next.findIndex((p: any) => p.id === product.id);
      if (i >= 0) next[i] = product;
      else next.push(product);
      plugin.config = {
        ...plugin.config,
        publicUrl: String(f.get("publicUrl")),
        ...(!editing?.id && {
          nextProductId: String(BigInt(productId) + 1n),
        }),
        products: next,
      };
      await host.request("/api/host/config", {
        method: "PUT",
        body: JSON.stringify(config),
      });
      setMessage(tr("已保存"));
      setEditing(undefined);
      data.reload();
      onSave();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    try {
      const config = await host.request<any>("/api/host/config");
      const plugin = find(config);
      plugin.config.products = plugin.config.products.filter(
        (p: Product) => p.id !== removing?.id,
      );
      await host.request("/api/host/config", {
        method: "PUT",
        body: JSON.stringify(config),
      });
      setRemoving(undefined);
      setMessage(tr("已保存"));
      data.reload();
      onSave();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading title={tr("商品与订阅")}>
        <button
          disabled={!data.data || busy}
          onClick={() => {
            setMessage("");
            setEditing({});
          }}
        >
          {tr("添加商品")}
        </button>
      </PageHeading>
      {!editing && !removing && <Notice message={message || data.error} />}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {[
                "ID",
                "商品",
                "购买模式",
                "支付金额",
                "到账额度（USD）",
                "操作",
              ].map((label) => (
                <th key={label}>{tr(label)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {products.map((product) => (
              <tr key={product.id}>
                <td>{product.id}</td>
                <td>{product.name}</td>
                <td>
                  {product.mode === "subscription"
                    ? tr("周期订阅 / 预付权益")
                    : tr("单次支付")}
                </td>
                <td>{price(product)}</td>
                <td>${(product.creditMicros / 1000000).toFixed(2)}</td>
                <td>
                  <div className="actions">
                    <button
                      className="ghost"
                      disabled={busy}
                      onClick={() => {
                        setMessage("");
                        setEditing(product);
                      }}
                    >
                      {tr("编辑")}
                    </button>
                    <button
                      className="ghost danger"
                      disabled={busy}
                      onClick={() => {
                        setMessage("");
                        setRemoving(product);
                      }}
                    >
                      {tr("下架")}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!products.length && <p className="empty-inline">{tr("暂无商品")}</p>}
      </div>
      {editing && (
        <Dialog
          title={editing.id ? tr("编辑商品") : tr("添加商品")}
          close={() => {
            if (!busy) setEditing(undefined);
          }}
        >
          <Notice message={message} />
          <form
            onSubmit={save}
            key={editing.id ?? "new"}
            className="product-editor"
          >
            <div className="form-grid">
              <label className="full">
                {tr("本站公开地址")}
                <input
                  name="publicUrl"
                  type="url"
                  required
                  defaultValue={settings.publicUrl ?? ""}
                  placeholder="https://example.com"
                />
              </label>
              <label>
                {tr("名称")}
                <input name="name" required defaultValue={editing.name ?? ""} />
              </label>
              <label>
                {tr("购买模式")}
                <Select
                  name="mode"
                  value={editing.mode ?? "payment"}
                  onChange={(event) =>
                    setEditing({
                      ...editing,
                      mode: event.target.value as Product["mode"],
                    })
                  }
                >
                  <option value="payment">{tr("单次支付")}</option>
                  <option value="subscription">
                    {tr("周期订阅 / 预付权益")}
                  </option>
                </Select>
              </label>
              {(editing.mode ?? "payment") === "subscription" && (
                <label>
                  {tr("周期")}
                  <Select
                    name="interval"
                    defaultValue={editing.interval ?? "month"}
                  >
                    <option value="month">{tr("每月")}</option>
                    <option value="year">{tr("每年")}</option>
                  </Select>
                </label>
              )}
              <label>
                {tr("支付币种")}
                <Select
                  name="currency"
                  defaultValue={editing.currency ?? "usd"}
                >
                  <option value="usd">{tr("USD · 美元")}</option>
                  <option value="cny">{tr("CNY · 人民币")}</option>
                  <option value="eur">{tr("EUR · 欧元")}</option>
                </Select>
              </label>
              <label>
                {tr("支付金额")}
                <input
                  name="payment"
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                  defaultValue={
                    editing.paymentMinor ? editing.paymentMinor / 100 : ""
                  }
                />
              </label>
              <label>
                {tr("到账额度（USD）")}
                <input
                  name="credit"
                  type="number"
                  min="0.000001"
                  step="0.000001"
                  required
                  defaultValue={
                    editing.creditMicros ? editing.creditMicros / 1000000 : ""
                  }
                />
              </label>
            </div>
            <div className="actions">
              <button disabled={busy}>{tr("保存商品")}</button>
            </div>
          </form>
        </Dialog>
      )}
      {removing && (
        <Dialog
          title={tr("下架商品")}
          close={() => {
            if (!busy) setRemoving(undefined);
          }}
        >
          <Notice message={message} />
          <p>
            {tr(
              "下架「{0} 」后不可再购买，历史订单和已生效订阅保持原有快照。",
              { "0": textValue(removing.name) },
            )}
          </p>
          <div className="form-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setRemoving(undefined)}
            >
              {tr("取消")}
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              {tr("确认下架")}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
