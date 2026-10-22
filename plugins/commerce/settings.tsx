import { t as tr, textValue } from "../../lib/ui/i18n.js";
import { Select } from "../../lib/ui/select.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { useLoad, Notice } from "../../lib/ui/mount.js";
import { Dialog } from "../../lib/ui/components.js";
import { usdToMicros } from "../../lib/commerce/decimal.js";
import { nextNumericId } from "../../lib/numeric-id.js";
export function ProductSettings({
  host,
  onSave,
}: {
  host: UIHost;
  onSave: () => void;
}) {
  const data = useLoad<any>(() => host.request("/api/host/config"));
  const [id, setId] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);
  const find = (c: any) =>
    c.plugins.find((p: any) =>
      /\/(?:official\.)?commerce$/.test(p.path.replaceAll("\\", "/")),
    );
  const settings = data.data ? (find(data.data)?.config ?? {}) : {};
  const products = settings.products ?? [];
  const selected = products.find((p: any) => p.id === id);
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
        selected?.id ??
        nextNumericId(
          (plugin.config.products ?? []).map((product: any) => product.id),
          plugin.config.nextProductId,
        );
      const product = {
        id: productId,
        name: String(f.get("name")),
        mode: String(f.get("mode")),
        interval: String(f.get("interval")),
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
        ...(!selected && {
          nextProductId: String(BigInt(productId) + 1n),
        }),
        products: next,
      };
      await host.request("/api/host/config", {
        method: "PUT",
        body: JSON.stringify(config),
      });
      setMessage(tr("已保存"));
      setId(product.id);
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
        (p: any) => p.id !== id,
      );
      await host.request("/api/host/config", {
        method: "PUT",
        body: JSON.stringify(config),
      });
      setId("");
      setRemoving(false);
      data.reload();
      onSave();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <h2>{tr("商品与结算配置")}</h2>
      <Notice message={message || data.error} />

      <label>
        {tr("编辑商品")}
        <Select value={id} onChange={(e) => setId(e.target.value)}>
          <option value="">{tr("添加商品")}</option>
          {products.map((p: any) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.id}
            </option>
          ))}
        </Select>
      </label>
      {data.data && (
        <form onSubmit={save} key={id + JSON.stringify(selected)}>
          <div className="form-grid">
            <label className="full">
              {tr("本站公开地址")}
              <input
                name="publicUrl"
                type="url"
                required
                defaultValue={settings.publicUrl ?? ""}
                placeholder="https://gateway.example.com"
              />
            </label>
            <label>
              {tr("名称")}
              <input name="name" required defaultValue={selected?.name ?? ""} />
            </label>
            <label>
              {tr("购买模式")}
              <Select name="mode" defaultValue={selected?.mode ?? "payment"}>
                <option value="payment">{tr("单次支付")}</option>
                <option value="subscription">
                  {tr("周期订阅 / 预付权益")}
                </option>
              </Select>
            </label>
            <label>
              {tr("周期")}
              <Select
                name="interval"
                defaultValue={selected?.interval ?? "month"}
              >
                <option value="month">{tr("每月")}</option>
                <option value="year">{tr("每年")}</option>
              </Select>
            </label>
            <label>
              {tr("支付币种")}
              <Select
                name="currency"
                defaultValue={selected?.currency ?? "usd"}
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
                defaultValue={selected ? selected.paymentMinor / 100 : ""}
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
                defaultValue={selected ? selected.creditMicros / 1000000 : ""}
              />
            </label>
          </div>
          <div className="actions">
            <button disabled={busy}>{tr("保存商品")}</button>
            {selected && (
              <button
                type="button"
                className="ghost danger"
                disabled={busy}
                onClick={() => setRemoving(true)}
              >
                {tr("下架商品")}
              </button>
            )}
          </div>
        </form>
      )}
      {removing && (
        <Dialog
          title={tr("下架商品")}
          close={() => {
            if (!busy) setRemoving(false);
          }}
        >
          <p>
            {tr(
              "下架「{0} 」后不可再购买，历史订单和已生效订阅保持原有快照。",
              { "0": textValue(selected?.name) },
            )}
          </p>
          <div className="form-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setRemoving(false)}
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
    </section>
  );
}
