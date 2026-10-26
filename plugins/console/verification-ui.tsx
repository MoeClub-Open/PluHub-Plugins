import { SecretInput } from "../../lib/ui/secret-input.js";
import { Checkbox } from "../../lib/ui/checkbox.js";
import { t as tr } from "../../lib/ui/i18n.js";
import React from "react";
import type { Extension, UIHost, UIExtensionModule } from "@pluhub/ui-sdk";
import { useLoad, Notice } from "../../lib/ui/mount.js";
import { Empty } from "../../lib/ui/components.js";
import { MailTemplateTools } from "../../lib/ui/mail-preview.js";
import { Select } from "../../lib/ui/select.js";
import { verificationPath, verificationTab } from "./navigation.js";
import {
  applyVerification,
  readVerification,
  type VerificationKind,
  type VerificationDrafts,
} from "./verification.js";

function ProviderPanel({
  provider,
  client,
}: {
  provider: Extension;
  client: UIHost;
}) {
  const element = React.useRef<HTMLDivElement>(null);
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    let canceled = false,
      dispose: (() => void) | undefined;
    const target = element.current;
    if (target)
      void import(provider.url)
        .then((module: UIExtensionModule) => {
          if (!canceled)
            dispose = module.mount(target, { ...client, page: provider.path });
        })
        .catch((e) => {
          if (!canceled) setError((e as Error).message);
        });
    return () => {
      canceled = true;
      dispose?.();
    };
  }, [provider.id, provider.url, client]);
  return (
    <>
      <Notice message={error} />
      <div ref={element} />
    </>
  );
}

export function VerificationSettings({
  client,
  providers,
  hash,
}: {
  client: UIHost;
  providers: Extension[];
  hash: string;
}) {
  const loaded = useLoad<any>(() => client.request("/api/host/config"));
  const [drafts, setDrafts] = React.useState<VerificationDrafts>({});
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [hostnamesText, setHostnamesText] = React.useState("");
  const [originsText, setOriginsText] = React.useState("");
  const baseline = React.useMemo(
    () => (loaded.data ? readVerification(loaded.data) : {}),
    [loaded.data],
  );
  React.useEffect(() => {
    setDrafts(structuredClone(baseline));
    setHostnamesText(baseline.turnstile?.hostnames?.join(", ") ?? "");
    setOriginsText(baseline.auth?.webauthn?.origins?.join(", ") ?? "");
  }, [baseline]);
  const active = (kind: VerificationKind) =>
    providers.some(
      (p) =>
        p.id === "official." + kind ||
        p.id.startsWith("official." + kind + ":"),
    );
  const auth = drafts.auth ?? {},
    mailer = drafts.mailer ?? {},
    turnstile = drafts.turnstile ?? {};
  const extra = providers.filter(
    (p) =>
      !["auth", "mailer", "turnstile"].some(
        (kind) =>
          p.id === "official." + kind ||
          p.id.startsWith("official." + kind + ":"),
      ),
  );
  const tabs = [
    { id: "account", title: tr("登录与注册") },
    { id: "email", title: tr("邮箱验证") },
    { id: "captcha", title: tr("人机验证") },
    { id: "passkeys", title: tr("Passkey 与两步验证") },
    ...extra.map((p) => ({ id: "provider:" + p.id, title: p.title })),
  ];
  const requested = verificationTab(hash),
    tab = tabs.some((t) => t.id === requested) ? requested : "account";
  const provider = extra.find((p) => tab === "provider:" + p.id);
  const dirty = JSON.stringify(drafts) !== JSON.stringify(baseline);
  function patch(kind: VerificationKind, update: Record<string, any>) {
    setMessage("");
    setDrafts((all) => ({ ...all, [kind]: { ...all[kind], ...update } }));
  }
  const check = (
    kind: VerificationKind,
    key: string,
    title: string,
    nested?: string,
    fallback = false,
  ) => {
    const config = drafts[kind] ?? {},
      value = nested ? config[nested]?.[key] : config[key];
    return (
      <label className="checkbox">
        <Checkbox
          appearance="switch"
          checked={(value ?? fallback) === true}
          disabled={!active(kind) || busy}
          onCheckedChange={(e) =>
            patch(
              kind,
              nested
                ? { [nested]: { ...config[nested], [key]: e === true } }
                : { [key]: e === true },
            )
          }
        />
        {title}
      </label>
    );
  };
  const input = (
    kind: VerificationKind,
    key: string,
    title: string,
    placeholder = "",
    type = "text",
  ) => (
    <label>
      {title}
      {key.endsWith("Ref") ? (
        <SecretInput
          key={kind + key}
          value={drafts[kind]?.[key]}
          disabled={!active(kind) || busy}
          onChange={(value) => patch(kind, { [key]: value })}
        />
      ) : (
        <input
          type={type}
          step={key === "minScore" ? "any" : undefined}
          min={key === "minScore" ? 0 : undefined}
          max={key === "minScore" ? 1 : undefined}
          value={drafts[kind]?.[key] ?? ""}
          placeholder={placeholder}
          disabled={!active(kind) || busy}
          onChange={(e) => {
            const next = { ...drafts[kind] };
            if (e.target.value)
              next[key] =
                type === "number" ? Number(e.target.value) : e.target.value;
            else delete next[key];
            setDrafts((all) => ({ ...all, [kind]: next }));
            setMessage("");
          }}
        />
      )}
    </label>
  );
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const config = await client.request<any>("/api/host/config");
      const changed = applyVerification(config, baseline, drafts);
      if (!changed) return;
      await client.request("/api/host/config", {
        method: "PUT",
        body: JSON.stringify(config),
      });
      setMessage(tr("登录策略与验证服务已一起校验并应用。"));
      loaded.reload();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const missing = (kind: VerificationKind) =>
    !active(kind) && (
      <p className="notice">
        {tr("对应插件未启用，")}
        <a href="#/plugins">{tr("前往插件管理")}</a>。
      </p>
    );
  return (
    <>
      <div className="verification-summary" aria-label={tr("验证服务概览")}>
        <span>
          {tr("邮箱验证")}{" "}
          <strong>
            {active("mailer") && mailer.enabled ? tr("已启用") : tr("未启用")}
          </strong>
        </span>
        <span>
          {tr("人机验证")}{" "}
          <strong>
            {active("turnstile") && turnstile.enabled
              ? tr("已启用")
              : tr("未启用")}
          </strong>
        </span>
        <span>
          Passkey{" "}
          <strong>
            {active("auth") && auth.webauthn?.enabled
              ? tr("已启用")
              : tr("未启用")}
          </strong>
        </span>
        <span>
          TOTP{" "}
          <strong>{active("auth") ? tr("用户自行绑定") : tr("不可用")}</strong>
        </span>
      </div>
      <nav
        className="settings-tabs verification-tabs"
        aria-label={tr("验证方式")}
      >
        {tabs.map((t) => (
          <a
            key={t.id}
            href={"#" + verificationPath + "?tab=" + encodeURIComponent(t.id)}
            className={tab === t.id ? "active" : ""}
            aria-current={tab === t.id ? "page" : undefined}
          >
            {t.title}
          </a>
        ))}
      </nav>
      <Notice message={message || loaded.error} />
      {provider ? (
        <ProviderPanel key={provider.id} provider={provider} client={client} />
      ) : (
        loaded.data && (
          <form onSubmit={save}>
            <section className="card verification-form">
              {tab === "account" && (
                <>
                  <h2>{tr("登录与注册策略")}</h2>
                  {missing("auth")}
                  <div className="form-grid">
                    {check(
                      "auth",
                      "registrationEnabled",
                      tr("开放邮箱验证注册"),
                    )}
                    {check(
                      "auth",
                      "emailLoginEnabled",
                      tr("启用邮箱验证码登录"),
                    )}
                    {check(
                      "auth",
                      "passwordResetEnabled",
                      tr("允许邮箱找回密码"),
                      undefined,
                      auth.emailLoginEnabled === true,
                    )}
                    {check(
                      "auth",
                      "secureCookie",
                      tr("仅通过 HTTPS 发送会话 Cookie"),
                    )}
                  </div>
                </>
              )}
              {tab === "email" && (
                <>
                  <h2>{tr("邮箱验证与发件服务")}</h2>
                  {missing("mailer")}
                  <div className="form-grid">
                    {check(
                      "auth",
                      "registrationEnabled",
                      tr("开放邮箱验证注册"),
                    )}
                    {check(
                      "auth",
                      "emailLoginEnabled",
                      tr("启用邮箱验证码登录"),
                    )}
                    {check(
                      "auth",
                      "passwordResetEnabled",
                      tr("允许邮箱找回密码"),
                      undefined,
                      auth.emailLoginEnabled === true,
                    )}
                    {check("mailer", "enabled", tr("启用邮件发送"))}
                  </div>
                  <div className="form-grid">
                    {input(
                      "mailer",
                      "host",
                      tr("SMTP 服务器"),
                      "smtp.example.com",
                    )}
                    {input("mailer", "port", tr("SMTP 端口"), "587", "number")}
                    {input(
                      "mailer",
                      "from",
                      tr("发件邮箱"),
                      "no-reply@example.com",
                      "email",
                    )}
                    {input("mailer", "user", tr("SMTP 用户名"))}
                    {input(
                      "mailer",
                      "tlsServerName",
                      tr("TLS 证书主机名（可选）"),
                      tr("默认使用 SMTP 服务器名"),
                    )}
                    {input("mailer", "passwordRef", tr("SMTP 密码"))}
                    {check(
                      "mailer",
                      "secure",
                      tr("隐式 TLS（通常使用 465 端口）"),
                    )}
                    {check(
                      "mailer",
                      "allowInsecure",
                      tr("允许本地 SMTP 测试服务明文连接"),
                    )}
                  </div>
                </>
              )}
              {tab === "captcha" && (
                <>
                  <h2>{tr("人机验证")}</h2>
                  {missing("turnstile")}

                  {check("turnstile", "enabled", tr("启用人机验证服务"))}
                  <div className="form-grid">
                    <label>
                      {tr("验证服务")}
                      <Select
                        value={turnstile.provider ?? "turnstile"}
                        disabled={!active("turnstile") || busy}
                        onChange={(event) =>
                          patch("turnstile", { provider: event.target.value })
                        }
                      >
                        <option value="turnstile">Cloudflare Turnstile</option>
                        <option value="recaptcha">Google reCAPTCHA</option>
                        <option value="geetest">{tr("极验 v4")}</option>
                      </Select>
                    </label>
                    {turnstile.provider === "recaptcha" && (
                      <>
                        <label>
                          {tr("验证版本")}
                          <Select
                            value={turnstile.recaptchaVersion ?? "v2"}
                            disabled={!active("turnstile") || busy}
                            onChange={(event) =>
                              patch("turnstile", {
                                recaptchaVersion: event.target.value,
                              })
                            }
                          >
                            <option value="v2">reCAPTCHA v2</option>
                            <option value="v3">reCAPTCHA v3</option>
                          </Select>
                        </label>
                        <label>
                          {tr("服务域名")}
                          <Select
                            value={
                              turnstile.recaptchaDomain ?? "www.google.com"
                            }
                            disabled={!active("turnstile") || busy}
                            onChange={(event) =>
                              patch("turnstile", {
                                recaptchaDomain: event.target.value,
                              })
                            }
                          >
                            <option value="www.google.com">
                              www.google.com
                            </option>
                            <option value="www.recaptcha.net">
                              www.recaptcha.net
                            </option>
                          </Select>
                        </label>
                        {turnstile.recaptchaVersion === "v3" &&
                          input(
                            "turnstile",
                            "minScore",
                            tr("最低评分"),
                            "0.5",
                            "number",
                          )}
                      </>
                    )}
                    {input(
                      "turnstile",
                      "siteKey",
                      turnstile.provider === "geetest"
                        ? "Captcha ID"
                        : tr("公开 Site Key"),
                    )}
                    {input("turnstile", "secretRef", tr("Secret Key"))}
                    {turnstile.provider !== "geetest" && (
                      <label>
                        {tr("允许的站点主机名")}
                        <input
                          value={hostnamesText}
                          disabled={!active("turnstile") || busy}
                          onChange={(e) => {
                            setHostnamesText(e.target.value);
                            patch("turnstile", {
                              hostnames: e.target.value
                                .split(/[\s,]+/)
                                .filter(Boolean),
                            });
                          }}
                          placeholder="hub.example.com"
                        />
                      </label>
                    )}
                  </div>
                  <h3>{tr("验证场景")}</h3>
                  <div className="form-grid">
                    {check("auth", "login", tr("登录需要人机验证"), "captcha")}
                    {check(
                      "auth",
                      "register",
                      tr("注册发送验证码前需要人机验证"),
                      "captcha",
                    )}
                    {check(
                      "auth",
                      "email",
                      tr("公开邮件验证码请求需要人机验证"),
                      "captcha",
                    )}
                  </div>
                </>
              )}
              {tab === "passkeys" && (
                <>
                  <h2>{tr("Passkey 与硬件安全密钥")}</h2>
                  {missing("auth")}
                  {check(
                    "auth",
                    "enabled",
                    tr("启用 Passkey / FIDO2 安全密钥"),
                    "webauthn",
                  )}
                  <div className="form-grid">
                    <label>
                      WebAuthn RP ID
                      <input
                        value={auth.webauthn?.rpID ?? ""}
                        disabled={!active("auth") || busy}
                        placeholder="hub.example.com"
                        onChange={(e) => {
                          const next = { ...auth.webauthn };
                          if (e.target.value) next.rpID = e.target.value;
                          else delete next.rpID;
                          patch("auth", { webauthn: next });
                        }}
                      />
                    </label>
                    <label>
                      {tr("允许的完整 Origin")}
                      <input
                        value={originsText}
                        disabled={!active("auth") || busy}
                        placeholder="https://hub.example.com"
                        onChange={(e) => {
                          setOriginsText(e.target.value);
                          const next = { ...auth.webauthn };
                          const origins = e.target.value
                            .split(/[\s,]+/)
                            .filter(Boolean);
                          if (origins.length) next.origins = origins;
                          else delete next.origins;
                          patch("auth", { webauthn: next });
                        }}
                      />
                    </label>
                  </div>
                </>
              )}
            </section>
            <div className="verification-actions">
              <span className="muted">
                {dirty ? tr("有未保存的修改") : tr("已保存")}
              </span>
              <button disabled={busy || !dirty}>
                {busy ? tr("保存中…") : tr("保存全部验证设置")}
              </button>
            </div>
          </form>
        )
      )}
      {tab === "email" && active("mailer") && (
        <MailTemplateTools host={client} disabled={busy || dirty} />
      )}
      {!providers.length && (
        <Empty title={tr("尚无验证服务")}>
          <a className="button secondary" href="#/plugins">
            {tr("管理插件")}
          </a>
        </Empty>
      )}
    </>
  );
}
