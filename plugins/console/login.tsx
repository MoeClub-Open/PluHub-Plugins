import { t as tr, textValue, getLocale } from "../../lib/ui/i18n.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { startAuthentication } from "@simplewebauthn/browser";
import { useLoad } from "../../lib/ui/mount.js";
import { Turnstile } from "../../lib/ui/turnstile.js";
import { Icon } from "../../lib/ui/components.js";
import { authLink } from "./navigation.js";
import { PasswordField } from "./auth-fields.js";
import { authError } from "./auth-errors.js";
import { PasswordReset } from "./password-reset.js";
const api = "/api/plugins/official.auth";
export function Login({
  client,
  done,
  siteName = "PluHub",
  register = false,
}: {
  client: UIHost;
  done: () => void;
  siteName?: string;
  register?: boolean;
}) {
  const options = useLoad<any>(() => client.request(api + "/options"));
  const [resetting, setResetting] = React.useState(false);
  const [mode, setMode] = React.useState(register ? "register" : "password"),
    [username, setUsername] = React.useState(""),
    [password, setPassword] = React.useState(""),
    [confirmPassword, setConfirmPassword] = React.useState(""),
    [email, setEmail] = React.useState(""),
    [code, setCode] = React.useState(""),
    [challenge, setChallenge] = React.useState(""),
    [recovery, setRecovery] = React.useState(false),
    [pending, setPending] = React.useState<"verify" | "send" | "passkey">(),
    [message, setMessage] = React.useState(""),
    [messageTone, setMessageTone] = React.useState("error"),
    [token, setToken] = React.useState(""),
    [reset, setReset] = React.useState(0);
  const emailInput = React.useRef<HTMLInputElement>(null);
  const codeInput = React.useRef<HTMLInputElement>(null);
  const busy = !!pending;
  React.useEffect(() => {
    if (challenge) codeInput.current?.focus();
  }, [challenge]);
  React.useEffect(() => {
    if (mode === "email") emailInput.current?.focus();
  }, [mode]);
  const [resendAt, setResendAt] = React.useState(0);
  const [now, setNow] = React.useState(Date.now());
  const cooldown = Math.max(0, Math.ceil((resendAt - now) / 1000));
  React.useEffect(() => {
    if (!resendAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [resendAt]);
  const c = options.data;
  const action =
    mode === "register" && c?.captcha.register
      ? "register"
      : mode === "password" || (mode === "email" && c?.captcha.login)
        ? "login"
        : "email";
  const needsCaptcha =
    mode !== "mfa" &&
    !!c?.captcha[action] &&
    (mode === "password" || !challenge || cooldown === 0);
  function switchMode(next: string) {
    setMode(next);
    setChallenge("");
    setCode("");
    setPassword("");
    setConfirmPassword("");
    setRecovery(false);
    setMessage("");
    setToken("");
    setReset((v) => v + 1);
  }
  async function run(
    fn: () => Promise<any>,
    operation: "verify" | "send" | "passkey" = "verify",
  ) {
    setPending(operation);
    setMessage("");
    try {
      const result = await fn();
      if (result?.mfaRequired) {
        setMode("mfa");
        setChallenge(result.challenge);
        setCode("");
      } else if (result) done();
    } catch (e) {
      const detail = (e as Error).message;
      setMessage(detail);
      setMessageTone("error");
      if (mode !== "mfa") setReset((v) => v + 1);
    } finally {
      setPending(undefined);
    }
  }
  async function send() {
    if (cooldown || !emailInput.current?.reportValidity()) return;
    await run(async () => {
      const result = await client.request<any>(api + "/email/request", {
        method: "POST",
        body: JSON.stringify({
          email: email.trim(),
          purpose: mode === "register" ? "register" : "login",
          language: getLocale(),
          turnstileToken: token,
        }),
      });
      setChallenge(result.challenge);
      setToken("");
      setNow(Date.now());
      setResendAt(Date.now() + 60000);
      setMessage("如邮箱符合条件，验证码已发送。");
      setMessageTone("success");
      setReset((v) => v + 1);
      return undefined;
    }, "send");
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (mode === "register" && password !== confirmPassword) {
      setMessage("两次输入的密码不一致，请检查后重试。");
      setMessageTone("error");
      return;
    }
    await run(() =>
      client.request(
        api +
          (mode === "password"
            ? "/login"
            : mode === "register"
              ? "/register"
              : mode === "mfa"
                ? "/login/mfa"
                : "/email/login"),
        {
          method: "POST",
          body: JSON.stringify(
            mode === "password"
              ? { username, password, turnstileToken: token }
              : mode === "mfa"
                ? {
                    challenge,
                    ...(recovery ? { recoveryCode: code } : { code }),
                  }
                : {
                    email: email.trim(),
                    challenge,
                    code,
                    ...(mode === "register"
                      ? { username, password, language: getLocale() }
                      : {}),
                  },
          ),
        },
      ),
    );
  }
  async function passkey() {
    await run(async () => {
      const start = await client.request<any>(api + "/passkeys/login/options", {
        method: "POST",
        body: JSON.stringify({
          ...(username ? { username } : {}),
          turnstileToken: token,
        }),
      });
      const response = await startAuthentication({
        optionsJSON: start.options,
      });
      return client.request(api + "/passkeys/login/verify", {
        method: "POST",
        body: JSON.stringify({ challenge: start.challenge, response }),
      });
    }, "passkey");
  }
  if (resetting && c)
    return (
      <PasswordReset
        client={client}
        options={c}
        back={() => {
          setResetting(false);
          setToken("");
          setReset((v) => v + 1);
        }}
        completed={(username) => {
          setResetting(false);
          switchMode("password");
          setUsername(username);
          setMessage("密码已重置，请使用新密码登录。");
          setMessageTone("success");
        }}
      />
    );
  if (register && (!c || !c.registrationEnabled || !c.mailEnabled))
    return (
      <main className="login">
        <span className="eyebrow">{siteName}</span>
        <h1>
          {!c
            ? tr("创建账号")
            : !c.registrationEnabled
              ? tr("注册暂未开放")
              : tr("注册暂时不可用")}
        </h1>
        {options.error ? (
          <>
            <p role="alert">{tr("暂时无法获取注册信息，请重试。")}</p>
            <button className="secondary" onClick={options.reload}>
              {tr("重试")}
            </button>
          </>
        ) : (
          <p className="muted" role="status">
            {!c
              ? tr("正在获取注册信息…")
              : !c.registrationEnabled
                ? tr("站点目前暂未开放新账号注册。已有账号可以直接登录。")
                : tr("暂时无法完成邮箱验证，请稍后重试或联系站点支持。")}
          </p>
        )}
        <p className="auth-switch">
          <a href={authLink("login", location.hash)}>{tr("返回登录")}</a>
        </p>
      </main>
    );
  return (
    <main className="login">
      <h1>
        {mode === "register"
          ? tr("创建账号")
          : mode === "mfa"
            ? tr("两步验证")
            : tr("登录")}
      </h1>
      {mode === "mfa" && (
        <p className="muted">{tr("输入六位动态码或恢复码。")}</p>
      )}
      {mode !== "mfa" && mode !== "register" && c?.emailLoginEnabled && (
        <div className="auth-methods" role="group" aria-label={tr("登录方式")}>
          <button
            type="button"
            className={mode === "password" ? "active" : ""}
            aria-pressed={mode === "password"}
            disabled={busy}
            onClick={() => switchMode("password")}
          >
            {tr("密码登录")}
          </button>
          {c?.emailLoginEnabled && (
            <button
              type="button"
              className={mode === "email" ? "active" : ""}
              aria-pressed={mode === "email"}
              disabled={busy}
              onClick={() => switchMode("email")}
            >
              {tr("邮箱登录")}
            </button>
          )}
        </div>
      )}
      {(message || options.error) && (
        <div
          className={"auth-feedback " + (options.error ? "error" : messageTone)}
          role={options.error || messageTone === "error" ? "alert" : "status"}
        >
          {authError(message || options.error)}
          {options.error && (
            <button
              type="button"
              className="secondary"
              onClick={options.reload}
            >
              {tr("重试")}
            </button>
          )}
        </div>
      )}
      <form onSubmit={submit} aria-busy={busy}>
        {(mode === "password" || mode === "register") && (
          <label>
            {tr("用户名")}
            <input
              name="username"
              disabled={busy}
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoFocus
              maxLength={64}
              minLength={mode === "register" ? 3 : undefined}
              pattern={
                mode === "register"
                  ? "[a-zA-Z0-9][a-zA-Z0-9_.\\-]{2,63}"
                  : undefined
              }
              placeholder={tr("输入用户名")}
            />
            {mode === "register" && (
              <small className="field-note">
                {tr("3–64 位，支持字母、数字、下划线、点和短横线。")}
              </small>
            )}
          </label>
        )}
        {(mode === "email" || mode === "register") && (
          <label>
            {tr("邮箱")}
            <input
              name="email"
              disabled={busy}
              ref={emailInput}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setChallenge("");
                setCode("");
              }}
              required
              placeholder="name@example.com"
            />
          </label>
        )}
        {(mode === "password" || mode === "register") && (
          <div className={mode === "register" ? "auth-password-pair" : ""}>
            <PasswordField
              disabled={busy}
              name="password"
              label={tr("密码")}
              value={password}
              change={setPassword}
              register={mode === "register"}
            />
            {mode === "register" && (
              <PasswordField
                disabled={busy}
                name="confirmPassword"
                label={tr("确认密码")}
                value={confirmPassword}
                change={setConfirmPassword}
                register
              />
            )}
          </div>
        )}
        {needsCaptcha &&
          (c?.turnstile?.enabled && c.turnstile.siteKey ? (
            <Turnstile
              siteKey={c.turnstile.siteKey}
              action={action}
              onToken={setToken}
              resetKey={reset}
            />
          ) : (
            <p role="alert">{tr("验证码服务尚未配置，暂时无法继续。")}</p>
          ))}
        {(mode === "email" || mode === "register" || mode === "mfa") && (
          <div className="auth-field">
            <label htmlFor="auth-code">
              {mode === "mfa" && recovery ? tr("恢复码") : tr("验证码")}
            </label>
            <div className={mode === "mfa" ? "" : "auth-code-row"}>
              <input
                id="auth-code"
                ref={codeInput}
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                disabled={mode !== "mfa" && !challenge}
                name="code"
                maxLength={recovery ? 64 : 6}
                pattern={recovery ? undefined : "[0-9]{6}"}
                inputMode={recovery ? "text" : "numeric"}
                placeholder={
                  recovery ? tr("输入一条未使用的恢复码") : tr("输入六位验证码")
                }
              />
              {mode !== "mfa" && (
                <button
                  type="button"
                  className="secondary"
                  disabled={
                    busy || !email || cooldown > 0 || (needsCaptcha && !token)
                  }
                  onClick={() => void send()}
                >
                  {pending === "send"
                    ? tr("正在发送…")
                    : cooldown
                      ? tr("{0} 秒后重发", { "0": textValue(cooldown) })
                      : challenge
                        ? tr("重新发送")
                        : tr("发送验证码")}
                </button>
              )}
            </div>
            {mode !== "mfa" && challenge && (
              <small className="field-note">
                {tr("验证码 10 分钟内有效。")}
              </small>
            )}
          </div>
        )}
        {mode === "password" && c?.passwordResetEnabled && c.mailEnabled && (
          <button
            type="button"
            className="ghost auth-forgot"
            disabled={busy}
            onClick={() => {
              setToken("");
              setResetting(true);
            }}
          >
            {tr("忘记密码？")}
          </button>
        )}
        <button
          className="auth-submit"
          disabled={
            busy ||
            !c ||
            (mode === "password" && needsCaptcha && !token) ||
            ((mode === "register" || mode === "email") && !challenge)
          }
        >
          {busy && pending !== "send"
            ? tr("正在验证…")
            : mode === "register"
              ? tr("验证并创建账号")
              : mode === "mfa"
                ? tr("验证并登录")
                : tr("登录 ") + siteName}
          <Icon name="arrow" size={17} />
        </button>
      </form>
      {mode === "mfa" ? (
        <div className="actions">
          <button
            className="ghost"
            onClick={() => {
              setRecovery((v) => !v);
              setCode("");
            }}
          >
            {recovery ? tr("使用验证器动态码") : tr("使用恢复码")}
          </button>
          <button className="ghost" onClick={() => switchMode("password")}>
            {tr("返回登录")}
          </button>
        </div>
      ) : (
        mode !== "register" &&
        c?.webauthnEnabled && (
          <button
            className="secondary passkey-login"
            disabled={
              busy ||
              (!!c.captcha.login &&
                !(needsCaptcha && action === "login" && token))
            }
            onClick={() => void passkey()}
          >
            <Icon name="key" size={16} />
            {tr("使用 Passkey / 安全密钥登录")}
          </button>
        )
      )}
      {mode !== "mfa" && (
        <p className="auth-switch">
          {mode === "register" ? (
            <>
              {tr("已有账号？")}
              <a href={authLink("login", location.hash)}>{tr("登录")}</a>
            </>
          ) : (
            <>
              {tr("还没有账号？")}{" "}
              <a href={authLink("register", location.hash)}>{tr("创建账号")}</a>
            </>
          )}
        </p>
      )}
    </main>
  );
}
