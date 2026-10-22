import { Checkbox } from "./checkbox.js";
import { t as tr } from "./i18n.js";
import { Select } from "./select.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { mountPage, useLoad, Notice } from "./mount.js";
import { PageHeading } from "./components.js";
export function paymentSettings() {
  function Page({ host }: { host: UIHost }) {
    const data = useLoad<any>(() => host.request("/api/host/config"));
    const [busy, setBusy] = React.useState(false);
    const [message, setMessage] = React.useState("");
    const find = (c: any) =>
      c.plugins.find((p: any) =>
        new RegExp("/(?:official\\.)?payments-stripe$").test(
          p.path.replaceAll("\\", "/"),
        ),
      );
    const settings = data.data ? (find(data.data)?.config ?? {}) : {};
    async function save(e: React.FormEvent<HTMLFormElement>) {
      e.preventDefault();
      setBusy(true);
      const f = new FormData(e.currentTarget);
      try {
        const config = await host.request<any>("/api/host/config");
        const p = find(config);
        if (!p) throw new Error(tr("支付插件未安装"));
        const next: any = { enabled: f.get("enabled") === "on" };
        const fields = ["keyRef", "webhookSecretRef"];
        for (const k of fields) {
          const value = String(f.get(k) ?? "").trim();
          if (value) next[k] = value;
        }
        next.livemode = f.get("livemode") === "true";
        next.secretRefs = [
          ...new Set(
            fields
              .filter((k) => k.endsWith("Ref"))
              .map((k) => next[k])
              .filter(Boolean),
          ),
        ];
        p.config = next;
        await host.request("/api/host/config", {
          method: "PUT",
          body: JSON.stringify(config),
        });
        setMessage(tr("已保存"));
        data.reload();
      } catch (e) {
        setMessage((e as Error).message);
      } finally {
        setBusy(false);
      }
    }
    const input = (name: string, title: string, placeholder = "") => (
      <label key={name}>
        {title}
        <input
          name={name}
          defaultValue={settings[name] ?? ""}
          placeholder={placeholder}
          autoComplete="off"
        />
      </label>
    );
    return (
      <>
        <PageHeading title={tr("Stripe 支付")} />
        <Notice message={message || data.error} />
        {data.data && (
          <form className="card" onSubmit={save} key={JSON.stringify(settings)}>
            <label className="checkbox">
              <Checkbox
                appearance="switch"
                name="enabled"
                defaultChecked={settings.enabled === true}
              />
              {tr("启用支付渠道")}
            </label>
            <div className="form-grid">
              {input(
                "keyRef",
                tr("Stripe Secret Key 引用"),
                "env:STRIPE_SECRET_KEY",
              )}
              {input(
                "webhookSecretRef",
                tr("Webhook 签名密钥引用"),
                "env:STRIPE_WEBHOOK_SECRET",
              )}
              <label>
                {tr("运行模式")}
                <Select
                  name="livemode"
                  defaultValue={String(settings.livemode ?? false)}
                >
                  <option value="false">{tr("测试模式")}</option>
                  <option value="true">{tr("正式模式")}</option>
                </Select>
              </label>
            </div>
            <label>
              {tr("回调地址")}
              <input
                readOnly
                value={
                  location.origin +
                  "/api/plugins/official.payments-stripe/webhook"
                }
              />
            </label>
            <button disabled={busy}>{tr("保存支付配置")}</button>
          </form>
        )}
      </>
    );
  }
  return (el: HTMLElement, host: UIHost) => mountPage(el, host, Page);
}
