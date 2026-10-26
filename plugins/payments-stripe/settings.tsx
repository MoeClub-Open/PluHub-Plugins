import { Checkbox } from "../../lib/ui/checkbox.js";
import { t as tr } from "../../lib/ui/i18n.js";
import { Select } from "../../lib/ui/select.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { mountPage, useLoad, Notice } from "../../lib/ui/mount.js";
import { PageHeading } from "../../lib/ui/components.js";
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
        const fields = [
          "keyRef",
          "webhookSecretRef",
          "previousWebhookSecretRef",
        ];
        const entered: Record<string, string> = {};
        for (const k of fields) {
          const value = String(f.get(k) ?? "").trim();
          if (value.startsWith("secret:")) next[k] = value;
          else if (value) entered[k] = value;
          else if (settings[k]) next[k] = settings[k];
        }
        if (Object.keys(entered).length)
          Object.assign(
            next,
            await host.request(
              "/api/plugins/official.payments-stripe/secrets",
              { method: "POST", body: JSON.stringify(entered) },
            ),
          );
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
              .filter((k) => k.endsWith("Ref"))
              .map((k) => next[k])
              .filter((value) => value?.startsWith("secret:")),
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
