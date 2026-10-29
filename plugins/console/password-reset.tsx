import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import type { AuthenticationOptions } from "@pluhub/contracts/security";
import { startAuthentication } from "@simplewebauthn/browser";
import { t as tr, getLocale } from "../../lib/ui/i18n.js";
import { Captcha, type CaptchaHandle } from "../../lib/ui/captcha.js";
import { PasswordField } from "./auth-fields.js";
import { authError } from "./auth-errors.js";
const api = "/api/plugins/official.auth";
type MFA = { challenge: string; methods: string[] };
export function PasswordReset({
  client,
  options,
  back,
  completed,
}: {
  client: UIHost;
  options: AuthenticationOptions;
  back: () => void;
  completed: (username: string) => void;
}) {
  const [email, setEmail] = React.useState(""),
    [code, setCode] = React.useState(""),
    [password, setPassword] = React.useState(""),
    [confirm, setConfirm] = React.useState("");
  const [challenge, setChallenge] = React.useState(""),
    [mfa, setMfa] = React.useState<MFA>(),
    [recovery, setRecovery] = React.useState(false);
  const [busy, setBusy] = React.useState(false),
    [sending, setSending] = React.useState(false),
    [message, setMessage] = React.useState(""),
    [tone, setTone] = React.useState("error");
  const [token, setToken] = React.useState(""),
    [captchaReset, setCaptchaReset] = React.useState(0),
    [resendAt, setResendAt] = React.useState(0),
    [now, setNow] = React.useState(Date.now());
  const emailInput = React.useRef<HTMLInputElement>(null),
    codeInput = React.useRef<HTMLInputElement>(null);
  const captcha = React.useRef<CaptchaHandle>(null);
  const captchaProvider = options.captchaProvider;
  const cooldown = Math.max(0, Math.ceil((resendAt - now) / 1000)),
    action = options.captcha.login ? "login" : "email",
    needsCaptcha = !!options.captcha[action];
  React.useEffect(() => {
    if (challenge || mfa) codeInput.current?.focus();
  }, [challenge, mfa]);
  React.useEffect(() => {
    if (!resendAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [resendAt]);
  const post = <T,>(path: string, body: unknown) =>
    client.request<T>(api + path, {
      method: "POST",
      body: JSON.stringify(body),
    });
  async function run(work: () => Promise<any>) {
    setBusy(true);
    setMessage("");
    try {
      const result = await work();
      if (result?.mfaRequired) {
        setMfa(result);
        setCode("");
        setPassword("");
        setConfirm("");
      } else if (result?.ok) completed(result.username);
    } catch (error) {
      const detail = (error as Error).message;
      setMessage(
        (error as Error).name === "NotAllowedError"
          ? "验证已取消或超时，请重试。"
          : detail,
      );
      setTone("error");
      if (
        detail === "Password recovery expired or changed; start again" ||
        detail === "Verification expired or is invalid; start again"
      ) {
        setMfa(undefined);
        setChallenge("");
        setCode("");
      }
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    if (busy || cooldown || !emailInput.current?.reportValidity()) return;
    setSending(true);
    await run(async () => {
      let result;
      try {
        result = await post<any>("/email/request", {
          purpose: "reset",
          email: email.trim(),
          language: getLocale(),
          captchaToken: needsCaptcha
            ? await captcha.current?.getToken()
            : undefined,
        });
      } catch (error) {
        setToken("");
        setCaptchaReset((v) => v + 1);
        throw error;
      }
      setChallenge(result.challenge);
      setCode("");
      setNow(Date.now());
      setResendAt(Date.now() + 60000);
      setMessage("如邮箱符合条件，验证码已发送。");
      setTone("success");
      setToken("");
      setCaptchaReset((v) => v + 1);
    });
    setSending(false);
  }
  async function passkey() {
    await run(async () => {
      const start = await post<any>("/passkeys/login/options", {
        resetChallenge: mfa!.challenge,
      });
      const response = await startAuthentication({
        optionsJSON: start.options,
      });
      await post("/passkeys/login/verify", {
        challenge: start.challenge,
        response,
      });
      try {
        return await post("/password/reset/finish", {
          challenge: mfa!.challenge,
        });
      } catch (error) {
        await post("/logout", {}).catch(() => {});
        throw error;
      }
    });
  }
  return (
    <main className="login">
      <h1>{mfa ? tr("两步验证") : tr("找回密码")}</h1>
      {!mfa && (
        <p className="muted">
          {tr("重置密码会退出全部设备，保留两步验证和 API Key。")}
        </p>
      )}
      {mfa && (
        <p className="muted">{tr("完成账号已启用的两步验证后重置密码。")}</p>
      )}
      {message && (
        <div
          className={"auth-feedback " + tone}
          role={tone === "error" ? "alert" : "status"}
        >
          {authError(message)}
        </div>
      )}
      <form
        className="auth-form-motion"
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          if (!mfa && password !== confirm) {
            setMessage("两次输入的密码不一致，请检查后重试。");
            setTone("error");
            return;
          }
          void run(() =>
            mfa
              ? post("/password/reset/finish", {
                  challenge: mfa.challenge,
                  ...(recovery ? { recoveryCode: code } : { code }),
                })
              : post("/password/reset", {
                  email: email.trim(),
                  challenge,
                  code,
                  password,
                }),
          );
        }}
      >
        {!mfa && (
          <>
            <label>
              {tr("绑定邮箱")}
              <input
                ref={emailInput}
                type="email"
                name="email"
                disabled={busy}
                autoComplete="email"
                required
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setChallenge("");
                  setCode("");
                }}
                placeholder="name@example.com"
                autoFocus
              />
            </label>
            {needsCaptcha &&
              (!challenge || cooldown === 0) &&
              (captchaProvider?.enabled && captchaProvider.siteKey ? (
                <Captcha
                  ref={captcha}
                  options={captchaProvider}
                  action={action}
                  onToken={setToken}
                  resetKey={captchaReset}
                />
              ) : (
                <p role="alert">{tr("验证码服务尚未配置，暂时无法继续。")}</p>
              ))}
          </>
        )}
        <div className="auth-field">
          <label htmlFor="password-reset-code">
            {mfa && recovery ? tr("恢复码") : tr("验证码")}
          </label>
          <div className={mfa ? "" : "auth-code-row"}>
            <input
              id="password-reset-code"
              ref={codeInput}
              name="code"
              autoComplete="one-time-code"
              required
              disabled={busy || (!mfa && !challenge)}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              maxLength={mfa && recovery ? 64 : 6}
              pattern={mfa && recovery ? undefined : "[0-9]{6}"}
              inputMode={mfa && recovery ? "text" : "numeric"}
              placeholder={
                mfa && recovery
                  ? tr("输入一条未使用的恢复码")
                  : tr("输入六位验证码")
              }
            />
            {!mfa && (
              <button
                type="button"
                className="secondary"
                disabled={
                  busy || !email || cooldown > 0 || (needsCaptcha && !token)
                }
                onClick={() => void send()}
              >
                {sending
                  ? tr("正在发送…")
                  : cooldown
                    ? tr("{0} 秒后重发", { "0": cooldown })
                    : challenge
                      ? tr("重新发送")
                      : tr("发送验证码")}
              </button>
            )}
          </div>
        </div>
        {!mfa && (
          <div className="auth-password-pair">
            <PasswordField
              disabled={busy}
              name="resetPassword"
              label={tr("新密码")}
              value={password}
              change={setPassword}
              register
            />
            <PasswordField
              disabled={busy}
              name="confirmPassword"
              label={tr("确认密码")}
              value={confirm}
              change={setConfirm}
              register
            />
          </div>
        )}
        <button className="auth-submit" disabled={busy || (!mfa && !challenge)}>
          {busy && !sending ? tr("正在验证…") : tr("重置密码")}
        </button>
      </form>
      {mfa && (
        <div className="actions">
          <button
            className="ghost"
            disabled={busy}
            onClick={() => {
              setRecovery((v) => !v);
              setCode("");
            }}
          >
            {recovery ? tr("使用验证器动态码") : tr("使用恢复码")}
          </button>
          {mfa.methods.includes("passkey") && (
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void passkey()}
            >
              {tr("使用 Passkey / 安全密钥验证")}
            </button>
          )}
        </div>
      )}
      <p className="auth-switch">
        <button className="ghost" type="button" disabled={busy} onClick={back}>
          {tr("返回登录")}
        </button>
      </p>
    </main>
  );
}
