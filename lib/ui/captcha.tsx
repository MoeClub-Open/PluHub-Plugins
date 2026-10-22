import React from "react";
import type { CaptchaOptions } from "@pluhub/contracts/security";
import { t as tr, getLocale } from "./i18n.js";

const scripts = new Map<string, Promise<void>>();
function loadScript(url: string) {
  if (!scripts.has(url)) {
    scripts.set(
      url,
      new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        const failed = () => {
          clearTimeout(timer);
          scripts.delete(url);
          script.remove();
          reject(Error(tr("验证码无法加载，请检查网络后重试")));
        };
        const timer = setTimeout(failed, 20000);
        script.src = url;
        script.async = true;
        script.onload = () => {
          clearTimeout(timer);
          resolve();
        };
        script.onerror = failed;
        document.head.append(script);
      }),
    );
  }
  return scripts.get(url)!;
}
export type CaptchaHandle = { getToken: () => Promise<string> };

export const Captcha = React.forwardRef<
  CaptchaHandle,
  {
    options: CaptchaOptions;
    action: string;
    onToken: (token: string) => void;
    resetKey: number;
  }
>(function Captcha({ options, action, onToken, resetKey }, ref) {
  const element = React.useRef<HTMLDivElement>(null);
  const callback = React.useRef(onToken);
  const token = React.useRef("");
  const execute = React.useRef<(() => Promise<string>) | undefined>(undefined);
  const [error, setError] = React.useState("");
  const [retry, setRetry] = React.useState(0);
  callback.current = onToken;
  const provider = options.provider ?? "turnstile";
  const siteKey = options.siteKey!;
  const version = options.recaptchaVersion ?? "v2";
  const domain =
    options.recaptchaDomain === "www.recaptcha.net"
      ? "www.recaptcha.net"
      : "www.google.com";
  const language = getLocale();
  React.useImperativeHandle(
    ref,
    () => ({
      async getToken() {
        const value = execute.current ? await execute.current() : token.current;
        if (!value) throw Error(tr("验证码验证失败，请重新尝试"));
        return value;
      },
    }),
    [],
  );
  React.useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    function update(value: string) {
      if (cancelled) return;
      token.current = value;
      callback.current(value);
    }
    function failed() {
      update("");
      if (!cancelled) setError(tr("验证码验证失败，请重新尝试"));
    }
    update("");
    execute.current = undefined;
    setError("");
    void (async () => {
      if (provider === "geetest") {
        await loadScript("https://static.geetest.com/v4/gt4.js");
        if (cancelled) return;
        (window as any).initGeetest4(
          {
            captchaId: siteKey,
            product: "float",
            protocol: "https://",
            language: language.startsWith("en") ? "eng" : "zho",
            offlineCb: failed,
            onError: failed,
          },
          (widget: any) => {
            if (cancelled) {
              widget.destroy();
              return;
            }
            dispose = () => widget.destroy();
            widget
              .onSuccess(() => {
                const result = widget.getValidate();
                if (result) update(JSON.stringify(result));
                else failed();
              })
              .onError(failed)
              .onFail(() => update(""));
            widget.appendTo(element.current);
          },
        );
      } else if (provider === "recaptcha") {
        await loadScript(
          `https://${domain}/recaptcha/api.js?render=explicit&hl=${language.startsWith("en") ? "en" : "zh-CN"}`,
        );
        const api = (window as any).grecaptcha;
        await new Promise<void>((resolve) => api.ready(resolve));
        if (cancelled || !element.current) return;
        const v3 = version === "v3";
        const id = api.render(element.current, {
          sitekey: siteKey,
          size: v3 ? "invisible" : "normal",
          badge: "inline",
          callback: (value: string) => update(v3 ? "ready" : value),
          "expired-callback": () => update(v3 ? "ready" : ""),
          "error-callback": failed,
        });
        dispose = () => {
          api.reset(id);
          element.current?.replaceChildren();
        };
        if (v3) {
          execute.current = async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              const value = await Promise.race([
                api.execute(id, { action }),
                new Promise<string>((_resolve, reject) => {
                  timer = setTimeout(
                    () => reject(Error(tr("验证码服务暂不可用，请稍后重试"))),
                    20000,
                  );
                }),
              ]);
              return cancelled ? "" : value;
            } finally {
              clearTimeout(timer);
            }
          };
          update("ready");
        }
      } else {
        await loadScript(
          "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
        );
        if (cancelled || !element.current) return;
        const api = (window as any).turnstile;
        const id = api.render(element.current, {
          sitekey: siteKey,
          action,
          theme: "auto",
          callback: update,
          "expired-callback": () => update(""),
          "error-callback": failed,
        });
        dispose = () => api.remove(id);
      }
    })().catch(() => {
      if (!cancelled) {
        update("");
        setError(tr("验证码无法加载，请检查网络后重试"));
      }
    });
    return () => {
      cancelled = true;
      execute.current = undefined;
      token.current = "";
      dispose?.();
    };
  }, [provider, siteKey, version, domain, language, action, resetKey, retry]);
  return (
    <div className="captcha-widget">
      <div ref={element} />
      {error && (
        <div role="alert" className="field-note">
          {error}
          <button
            type="button"
            className="ghost"
            onClick={() => setRetry((value) => value + 1)}
          >
            {tr("重试")}
          </button>
        </div>
      )}
    </div>
  );
});
