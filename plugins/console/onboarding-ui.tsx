import { Checkbox } from "../../lib/ui/checkbox.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { Notice } from "../../lib/ui/mount.js";
import { Icon } from "../../lib/ui/components.js";
import { Select } from "../../lib/ui/select.js";
import {
  getLocale,
  setLanguagePreference,
  setSiteLanguage,
  t as tr,
  textValue,
} from "../../lib/ui/i18n.js";
import { isLocale, type Locale } from "@pluhub/ui-sdk";
import { readBranding } from "./branding.js";
import { readPortal, defaultPortalFor } from "./portal.js";
import { onboardingChecks, type SetupState } from "./onboarding.js";

const steps = ["站点信息", "公开门户", "确认设置", "管理员账号"];
const setupLanguageKey = "pluhub.setup.language";
function savedSetupLanguage(initial: SetupState): Locale | undefined {
  const saved = initial.branding?.defaultLanguage;
  if (isLocale(saved)) return saved;
  try {
    const draft = sessionStorage.getItem(setupLanguageKey);
    return isLocale(draft) ? draft : undefined;
  } catch {
    return undefined;
  }
}
export function Onboarding({
  host,
  initial,
  onComplete,
}: {
  host: UIHost;
  initial: SetupState;
  onComplete: () => void;
}) {
  const [state, setState] = React.useState(initial);
  const [step, setStep] = React.useState(initial.step ?? 0);
  const [savedLanguage] = React.useState(() => savedSetupLanguage(initial));
  const [languageChosen, setLanguageChosen] = React.useState(!!savedLanguage);
  const [languageChoice, setLanguageChoice] = React.useState<Locale>(
    savedLanguage ?? getLocale(),
  );
  const initialBranding = {
    ...initial.branding,
    ...(savedLanguage ? { defaultLanguage: savedLanguage } : {}),
  };
  const [brand, setBrand] = React.useState(() =>
    readBranding({ branding: initialBranding }),
  );
  const [portal, setPortal] = React.useState(() =>
    readPortal({ portal: initial.portal, branding: initialBranding }),
  );
  const [username, setUsername] = React.useState("admin");
  const [password, setPassword] = React.useState("");
  const [confirmation, setConfirmation] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  React.useEffect(() => {
    if (savedLanguage) {
      setSiteLanguage(savedLanguage);
      setLanguagePreference(savedLanguage);
    }
  }, [savedLanguage]);
  function chooseLanguage(locale: Locale) {
    const previous = defaultPortalFor(brand.defaultLanguage);
    const next = defaultPortalFor(locale);
    setPortal(
      Object.fromEntries(
        Object.entries(portal).map(([key, value]) => [
          key,
          JSON.stringify(value) ===
          JSON.stringify(previous[key as keyof typeof previous])
            ? next[key as keyof typeof next]
            : value,
        ]),
      ) as typeof portal,
    );
    setBrand({
      ...brand,
      defaultLanguage: locale,
      description: ["AI 模型服务", "AI model service"].includes(
        brand.description,
      )
        ? locale === "en-US"
          ? "AI model service"
          : "AI 模型服务"
        : brand.description,
    });
    setSiteLanguage(locale);
    setLanguagePreference(locale);
    try {
      sessionStorage.setItem(setupLanguageKey, locale);
    } catch {
      /* Optional draft cache. */
    }
    setLanguageChosen(true);
  }
  function complete() {
    try {
      sessionStorage.removeItem(setupLanguageKey);
    } catch {
      /* Optional draft cache. */
    }
    onComplete();
  }
  const { origin: originOk, cookie: cookieOk } = onboardingChecks(
    state,
    location.origin,
  );
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (step === 3 && password !== confirmation) {
      setMessage(tr("两次输入的密码不一致"));
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const next = await host.request<SetupState>("/api/host/setup", {
        method: "POST",
        headers: { "x-pluhub-setup": "1" },
        body: JSON.stringify(
          step === 3
            ? { action: "admin", revision: state.revision, username, password }
            : {
                action: "site",
                revision: state.revision,
                step,
                branding: brand,
                portal,
              },
        ),
      });
      if (!next.required) {
        setPassword("");
        setConfirmation("");
        complete();
        return;
      }
      setState(next);
      setStep(step + 1);
      window.dispatchEvent(new Event("pluhub:branding"));
      window.dispatchEvent(new Event("pluhub:public"));
      window.scrollTo(0, 0);
    } catch (error) {
      // A different tab may have won, or persistence may fail after account creation.
      try {
        const current = await host.request<SetupState>("/api/host/setup");
        if (!current.required) {
          setPassword("");
          setConfirmation("");
          complete();
          return;
        }
      } catch {
        /* Keep the original failure and allow an explicit reload. */
      }
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!languageChosen)
    return (
      <div className="onboarding">
        <div className="onboarding-heading">
          <h1>{"选择语言 / Choose a language"}</h1>
        </div>
        <form
          className="card onboarding-panel"
          onSubmit={(event) => {
            event.preventDefault();
            chooseLanguage(languageChoice);
          }}
        >
          <Select
            aria-label="语言 / Language"
            value={languageChoice}
            onChange={(event) =>
              setLanguageChoice(event.target.value as Locale)
            }
          >
            <option value="zh-CN">简体中文</option>
            <option value="en-US">English</option>
          </Select>
          <div className="form-actions">
            <button>{"继续 / Continue"}</button>
          </div>
        </form>
      </div>
    );
  return (
    <div className="onboarding">
      <div className="onboarding-heading">
        <span className="eyebrow">{tr("首次部署")}</span>
        <h1>{tr("初始化你的站点")}</h1>
      </div>
      <ol className="onboarding-steps" aria-label={tr("初始化进度")}>
        {steps.map((title, index) => (
          <li key={title} aria-current={step === index ? "step" : undefined}>
            <button
              className={step === index ? "active" : ""}
              disabled={busy || index > Math.max(step, state.step ?? 0)}
              onClick={() => {
                setStep(index);
                setMessage("");
              }}
            >
              <span>
                {index < step ? <Icon name="check" size={15} /> : index + 1}
              </span>
              {tr(title)}
            </button>
          </li>
        ))}
      </ol>
      <Notice message={message} />
      {message && (
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const current = await host.request<SetupState>("/api/host/setup");
              if (!current.required) {
                complete();
                return;
              }
              setState(current);
              setStep(current.step ?? 0);
              setBrand(readBranding({ branding: current.branding }));
              setPortal(
                readPortal({
                  portal: current.portal,
                  branding: current.branding,
                }),
              );
              setMessage("");
            } catch (error) {
              setMessage((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {tr("重新加载已保存设置")}
        </button>
      )}
      <form key={step} className="card onboarding-panel" onSubmit={submit}>
        {step === 0 && (
          <>
            <h2>{tr("设置站点信息")}</h2>

            <div className="form-grid">
              <label>
                {tr("站点默认语言")}
                <Select
                  aria-label={tr("站点默认语言")}
                  value={brand.defaultLanguage}
                  onChange={(event) =>
                    chooseLanguage(event.target.value as Locale)
                  }
                >
                  <option value="zh-CN">{tr("简体中文")}</option>
                  <option value="en-US">{tr("英语")}</option>
                </Select>
              </label>
              <label>
                {tr("站点名称")}
                <input
                  required
                  maxLength={64}
                  value={brand.name}
                  onChange={(e) => setBrand({ ...brand, name: e.target.value })}
                />
              </label>
              <label>
                {tr("联系邮箱")}
                <input
                  type="email"
                  maxLength={254}
                  placeholder={tr("可选")}
                  value={brand.supportEmail}
                  onChange={(e) =>
                    setBrand({ ...brand, supportEmail: e.target.value })
                  }
                />
              </label>
              <label>
                {tr("站点简介")}
                <textarea
                  maxLength={200}
                  value={brand.description}
                  onChange={(e) =>
                    setBrand({ ...brand, description: e.target.value })
                  }
                />
              </label>
              <label>
                {tr("Logo 地址")}
                <input
                  maxLength={2048}
                  placeholder={tr("可选，HTTPS 或站内路径")}
                  value={brand.logoUrl}
                  onChange={(e) =>
                    setBrand({ ...brand, logoUrl: e.target.value })
                  }
                />
              </label>
              <label>
                {tr("主题色")}
                <input
                  type="color"
                  value={brand.accentColor}
                  onChange={(e) =>
                    setBrand({ ...brand, accentColor: e.target.value })
                  }
                />
              </label>
              <label>
                {tr("页脚文字")}
                <input
                  maxLength={200}
                  value={brand.footerText}
                  onChange={(e) =>
                    setBrand({ ...brand, footerText: e.target.value })
                  }
                />
              </label>
            </div>
          </>
        )}
        {step === 1 && (
          <>
            <h2>{tr("准备公开门户")}</h2>

            <label className="checkbox">
              <Checkbox
                appearance="switch"
                checked={portal.enabled}
                onCheckedChange={(e) =>
                  setPortal({ ...portal, enabled: e === true })
                }
              />
              {tr("启用落地门户页")}
            </label>
            <label>
              {tr("门户标题")}
              <textarea
                required
                maxLength={160}
                value={portal.title}
                onChange={(e) =>
                  setPortal({ ...portal, title: e.target.value })
                }
              />
            </label>
            <label>
              {tr("门户简介")}
              <textarea
                maxLength={600}
                value={portal.description}
                onChange={(e) =>
                  setPortal({ ...portal, description: e.target.value })
                }
              />
            </label>
          </>
        )}
        {step === 2 && (
          <>
            <h2>{tr("确认站点设置")}</h2>

            <div className="onboarding-checks">
              {[
                [tr("站点名称"), true, brand.name],
                [
                  tr("站点默认语言"),
                  true,
                  brand.defaultLanguage === "en-US"
                    ? tr("英语")
                    : tr("简体中文"),
                ],
                [
                  tr("公开门户"),
                  true,
                  portal.enabled ? portal.title : tr("未启用，直接进入登录页"),
                ],
                [tr("对外访问地址"), originOk, location.origin],
                [
                  tr("会话安全"),
                  cookieOk,
                  location.protocol === "https:"
                    ? tr("HTTPS 与 Secure Cookie")
                    : tr("当前使用 HTTP"),
                ],
              ].map(([title, ok, description]) => (
                <div key={String(title)}>
                  <Icon name={ok ? "check" : "clock"} />
                  <span>
                    <strong>{title}</strong>
                    <small>{description}</small>
                  </span>
                  <span className="badge">
                    {ok ? tr("就绪") : tr("需修正")}
                  </span>
                </div>
              ))}
            </div>
            {(!originOk || !cookieOk) && (
              <p className="notice">
                {tr(
                  "当前访问地址与部署配置不一致。请先设置 PLUHUB_PUBLIC_ORIGIN；已有配置可停机执行 set-public-origin 后重新启动。",
                )}
              </p>
            )}
          </>
        )}
        {step === 3 && (
          <>
            <h2>{tr("创建管理员账号")}</h2>

            <div className="setup-account-fields">
              <label>
                {tr("管理员用户名")}
                <input
                  required
                  autoComplete="username"
                  minLength={3}
                  maxLength={64}
                  pattern="[a-zA-Z0-9][a-zA-Z0-9_.\-]{2,63}"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </label>
              <label>
                {tr("管理员密码")}
                <input
                  required
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={1024}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              <label>
                {tr("确认密码")}
                <input
                  required
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={1024}
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                />
              </label>
              <label className="checkbox">
                <Checkbox
                  checked={showPassword}
                  onCheckedChange={(e) => setShowPassword(e === true)}
                />
                {tr("显示密码")}
              </label>
            </div>
            <p className="field-note">{tr("密码至少 12 位。")}</p>
          </>
        )}
        <div className="onboarding-actions">
          <span className="muted">
            {tr("第 {0} 步，共 4 步", { "0": textValue(step + 1) })}
          </span>
          <div className="actions">
            {step > 0 && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setStep(step - 1);
                  setMessage("");
                }}
              >
                {tr("上一步")}
              </button>
            )}
            <button disabled={busy || (step === 2 && (!originOk || !cookieOk))}>
              {busy
                ? tr("正在保存…")
                : step === 3
                  ? tr("创建管理员并进入登录")
                  : step === 2
                    ? tr("确认并创建管理员")
                    : tr("保存并继续")}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
