import { t as tr } from "./i18n.js";
import { Select } from "./select.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { mountPage, useLoad, Notice } from "./mount.js";
import { PageHeading } from "./components.js";
export function paymentSettings(kind: "stripe" | "epay") {
  function Page({ host }: { host: UIHost }) {
    const data = useLoad<any>(() => host.request("/api/host/config"));
    const [busy, setBusy] = React.useState(false);
    const [message, setMessage] = React.useState("");
    const find = (c: any) =>
      c.plugins.find((p: any) =>
        new RegExp("/(?:official\\.)?payments-" + kind + "$").test(
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
        const fields =
          kind === "stripe"
            ? ["keyRef", "webhookSecretRef"]
            : [
                "version",
                "algorithm",
                "pid",
                "baseUrl",
                "publicUrl",
                "paymentType",
                "clientIp",
                "keyRef",
                "privateKeyRef",
                "platformPublicKeyRef",
              ];
        for (const k of fields) {
          const value = String(f.get(k) ?? "").trim();
          if (value) next[k] = value;
        }
        if (kind === "stripe") next.livemode = f.get("livemode") === "true";
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
        <PageHeading
          title={kind === "stripe" ? tr("Stripe 支付") : tr("易支付")}
        />
        <Notice message={message || data.error} />
        {data.data && (
          <form className="card" onSubmit={save} key={JSON.stringify(settings)}>
            <label className="checkbox">
              <input
                name="enabled"
                type="checkbox"
                defaultChecked={settings.enabled === true}
              />
              {tr("启用支付渠道")}
            </label>
            <div className="form-grid">
              {kind === "stripe" ? (
                <>
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
                </>
              ) : (
                <>
                  <label>
                    {tr("API 版本")}
                    <Select
                      name="version"
                      defaultValue={settings.version ?? "v1"}
                    >
                      <option value="v1">V1 · submit.php</option>
                      <option value="v2">V2 · api/pay/create</option>
                    </Select>
                  </label>
                  <label>
                    {tr("签名方式")}
                    <Select
                      name="algorithm"
                      defaultValue={settings.algorithm ?? "MD5"}
                    >
                      <option>MD5</option>
                      <option>RSA</option>
                    </Select>
                  </label>
                  {input("pid", tr("商户 PID"))}
                  {input(
                    "baseUrl",
                    tr("支付平台地址"),
                    "https://pay.example.com",
                  )}
                  {input(
                    "publicUrl",
                    tr("本站公开地址"),
                    "https://gateway.example.com",
                  )}
                  <label>
                    {tr("支付类型")}
                    <Select
                      name="paymentType"
                      defaultValue={settings.paymentType ?? "alipay"}
                    >
                      <option value="alipay">{tr("支付宝")}</option>
                      <option value="wxpay">{tr("微信支付")}</option>
                      <option value="qqpay">{tr("QQ 钱包")}</option>
                    </Select>
                  </label>
                  {input("clientIp", tr("创建订单来源 IP"), "127.0.0.1")}
                  {input("keyRef", tr("MD5 商户密钥引用"), "env:EPAY_KEY")}
                  {input(
                    "privateKeyRef",
                    tr("RSA 商户私钥引用"),
                    "env:EPAY_PRIVATE_KEY",
                  )}
                  {input(
                    "platformPublicKeyRef",
                    tr("RSA 平台公钥引用"),
                    "env:EPAY_PLATFORM_PUBLIC_KEY",
                  )}
                </>
              )}
            </div>
            <label>
              {tr("回调地址")}
              <input
                readOnly
                value={
                  location.origin +
                  (kind === "stripe"
                    ? "/api/plugins/official.payments-stripe/webhook"
                    : "/api/plugins/official.payments-epay/notify")
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
