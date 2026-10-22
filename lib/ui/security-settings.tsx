import { Checkbox } from "./checkbox.js";
import { t as tr } from "./i18n.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { mountPage, useLoad, Notice } from "./mount.js";
import { PageHeading } from "./components.js";
import { MailTemplateTools } from "./mail-preview.js";
export function SecurityProviderForm({
  host,
  kind,
  onSaved,
}: {
  host: UIHost;
  kind: "auth" | "mailer";
  onSaved?: () => void;
}) {
  const loaded = useLoad<any>(() => host.request("/api/host/config"));
  const [message, setMessage] = React.useState(""),
    [busy, setBusy] = React.useState(false);
  const find = (c: any) =>
    c.plugins.find((p: any) =>
      new RegExp("/(?:official\\.)?" + kind + "$").test(
        p.path.replaceAll("\\", "/"),
      ),
    );
  const settings = loaded.data ? (find(loaded.data)?.config ?? {}) : {};
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget),
      value = (n: string) => String(f.get(n) ?? "").trim(),
      checked = (n: string) => f.get(n) === "on";
    setBusy(true);
    try {
      const config = await host.request<any>("/api/host/config"),
        plugin = find(config);
      if (!plugin) throw Error(tr("插件未安装"));
      const next: any = { ...plugin.config };
      if (kind === "auth") {
        next.registrationEnabled = checked("registrationEnabled");
        next.emailLoginEnabled = checked("emailLoginEnabled");
        next.passwordResetEnabled = checked("passwordResetEnabled");
        next.secureCookie = checked("secureCookie");
        next.captcha = {
          login: checked("captchaLogin"),
          register: checked("captchaRegister"),
          email: checked("captchaEmail"),
        };
        next.webauthn = {
          enabled: checked("webauthn"),
          ...(value("rpID") ? { rpID: value("rpID") } : {}),
          ...(value("origins")
            ? {
                origins: value("origins")
                  .split(/[\s,]+/)
                  .filter(Boolean),
              }
            : {}),
        };
      } else {
        next.enabled = checked("enabled");
        for (const n of [
          "host",
          "from",
          "user",
          "passwordRef",
          "tlsServerName",
        ])
          if (value(n)) next[n] = value(n);
          else delete next[n];
        next.port = Number(value("port") || 587);
        next.secure = checked("secure");
        next.allowInsecure = checked("allowInsecure");
        next.secretRefs = next.passwordRef ? [next.passwordRef] : [];
      }
      plugin.config = next;
      await host.request("/api/host/config", {
        method: "PUT",
        body: JSON.stringify(config),
      });
      setMessage(tr("已保存"));
      loaded.reload();
      onSaved?.();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const input = (
    name: string,
    title: string,
    placeholder = "",
    value?: string,
  ) => (
    <label key={name}>
      {title}
      <input
        name={name}
        defaultValue={value ?? settings[name] ?? ""}
        placeholder={placeholder}
        autoComplete="off"
      />
    </label>
  );
  const check = (name: string, title: string, value?: boolean) => (
    <label key={name} className="checkbox">
      <Checkbox
        appearance="switch"
        name={name}
        defaultChecked={value ?? settings[name] === true}
      />
      {title}
    </label>
  );
  return (
    <>
      <Notice message={message || loaded.error} />
      {loaded.data && (
        <form className="card" key={JSON.stringify(settings)} onSubmit={save}>
          {kind !== "auth" && check("enabled", tr("启用邮件发送"))}
          <div className="form-grid">
            {kind === "mailer" ? (
              <>
                {input("host", tr("SMTP 服务器"), "smtp.example.com")}
                {input("port", tr("SMTP 端口"), "587")}
                {input("from", tr("发件邮箱"), "no-reply@example.com")}
                {input("user", tr("SMTP 用户名"))}
                {input(
                  "tlsServerName",
                  tr("TLS 证书主机名（可选）"),
                  tr("默认使用 SMTP 服务器名"),
                )}
                {input("passwordRef", tr("SMTP 密码引用"), "env:SMTP_PASSWORD")}
                {check("secure", tr("隐式 TLS（通常使用 465 端口）"))}
                {check("allowInsecure", tr("允许本地 SMTP 测试服务明文连接"))}
              </>
            ) : (
              <>
                {check("registrationEnabled", tr("开放邮箱验证注册"))}
                {check("emailLoginEnabled", tr("启用邮箱验证码登录"))}
                {check(
                  "passwordResetEnabled",
                  tr("允许邮箱找回密码"),
                  settings.passwordResetEnabled ??
                    settings.emailLoginEnabled === true,
                )}
                {check("secureCookie", tr("仅通过 HTTPS 发送会话 Cookie"))}
                {check(
                  "captchaLogin",
                  tr("登录需要人机验证"),
                  settings.captcha?.login ?? false,
                )}
                {check(
                  "captchaRegister",
                  tr("注册发送验证码前需要人机验证"),
                  settings.captcha?.register ?? false,
                )}
                {check(
                  "captchaEmail",
                  tr("公开邮件验证码请求需要人机验证"),
                  settings.captcha?.email ?? false,
                )}
                {check(
                  "webauthn",
                  tr("启用 Passkey / FIDO2 安全密钥"),
                  settings.webauthn?.enabled ?? false,
                )}
                {input(
                  "rpID",
                  "WebAuthn RP ID",
                  "hub.example.com",
                  settings.webauthn?.rpID ?? "",
                )}
                {input(
                  "origins",
                  tr("允许的完整 Origin"),
                  "https://hub.example.com",
                  settings.webauthn?.origins?.join(", ") ?? "",
                )}
              </>
            )}
          </div>
          <p>
            <button disabled={busy}>{tr("保存并应用")}</button>
          </p>
        </form>
      )}
      {kind === "mailer" && <MailTemplateTools host={host} disabled={busy} />}
    </>
  );
}
export function securityProvider(kind: "mailer") {
  function Page({ host }: { host: UIHost }) {
    return (
      <>
        <PageHeading title={tr("邮件发件")} />
        <SecurityProviderForm host={host} kind={kind} />
      </>
    );
  }
  return (el: HTMLElement, host: UIHost) => mountPage(el, host, Page);
}
