import { Checkbox } from "../../lib/ui/checkbox.js";
import { t as tr } from "../../lib/ui/i18n.js";
import { Select } from "../../lib/ui/select.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { mountPage, Notice } from "../../lib/ui/mount.js";
import { usePluginConfig } from "../../lib/ui/plugin-config.js";
import { PageHeading } from "../../lib/ui/components.js";
export function paymentSettings() {
  function Page({ host }: { host: UIHost }) {
    const data = usePluginConfig(host, "official.payments-stripe");
    const [busy, setBusy] = React.useState(false);
    const [message, setMessage] = React.useState("");
    const settings = data.data ?? {};
    async function save(e: React.FormEvent<HTMLFormElement>) {
      e.preventDefault();
      setBusy(true);
      const f = new FormData(e.currentTarget);
      try {
        const fields = [
          "keyRef",
          "webhookSecretRef",
          "previousWebhookSecretRef",
        ];
        const entered: Record<string, string> = {};
        for (const k of fields) {
          const value = String(f.get(k) ?? "").trim();
          if (value && !value.startsWith("secret:")) entered[k] = value;
        }
        const storedSecrets = Object.keys(entered).length
          ? await host.request<Record<string, string>>(
              "/api/plugins/official.payments-stripe/secrets",
              { method: "POST", body: JSON.stringify(entered) },
            )
          : {};
        await data.save((current) => {
          const next: any = { enabled: f.get("enabled") === "on" };
          for (const k of fields) {
            const value = String(f.get(k) ?? "").trim();
            if (value.startsWith("secret:")) next[k] = value;
            else if (storedSecrets[k]) next[k] = storedSecrets[k];
            else if (current?.[k]) next[k] = current[k];
          }
          if (f.get("clearPrevious") === "on")
            delete next.previousWebhookSecretRef;
          next.portalEnabled = f.get("portalEnabled") === "on";
          if (f.get("portalConfiguration"))
            next.portalConfiguration = String(
              f.get("portalConfiguration"),
            ).trim();
          next.livemode = f.get("livemode") === "true";
          next.secretRefs = [
            ...new Set(
              fields
                .map((k) => next[k])
                .filter((value) => value?.startsWith("secret:")),
            ),
          ];
          return next;
        });
        setMessage(tr("已保存"));
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
          type={name.endsWith("Ref") ? "password" : "text"}
          defaultValue={name.endsWith("Ref") ? "" : (settings[name] ?? "")}
          placeholder={
            name.endsWith("Ref") && settings[name]
              ? tr("已设置，留空保留")
              : placeholder
          }
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
              {input("keyRef", "Stripe Secret Key", "sk_…")}
              {input("webhookSecretRef", tr("Webhook 签名密钥"), "whsec_…")}
              {input(
                "previousWebhookSecretRef",
                tr("轮换期间的旧签名密钥"),
                "whsec_…",
              )}
              {settings.previousWebhookSecretRef && (
                <label className="checkbox">
                  <Checkbox name="clearPrevious" />
                  {tr("结束旧密钥轮换")}
                </label>
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
            <label className="checkbox">
              <Checkbox
                appearance="switch"
                name="portalEnabled"
                defaultChecked={settings.portalEnabled === true}
              />
              {tr("Stripe 账单门户")}
            </label>
            {input("portalConfiguration", tr("账单门户配置 ID"), "bpc_…")}
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
