import { t as tr } from "./i18n.js";
import React from "react";
let loading: Promise<any> | undefined;
function load() {
  if ((window as any).turnstile)
    return Promise.resolve((window as any).turnstile);
  return (loading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src =
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = () => resolve((window as any).turnstile);
    script.onerror = () => {
      loading = undefined;
      script.remove();
      reject(Error(tr("验证码无法加载，请检查网络后重试")));
    };
    document.head.append(script);
  }));
}
export function Turnstile({
  siteKey,
  action,
  onToken,
  resetKey,
}: {
  siteKey: string;
  action: string;
  onToken: (token: string) => void;
  resetKey: number;
}) {
  const element = React.useRef<HTMLDivElement>(null),
    callback = React.useRef(onToken);
  callback.current = onToken;
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    let cancelled = false,
      id: string | undefined,
      api: any;
    callback.current("");
    setError("");
    void load()
      .then((t) => {
        api = t;
        if (!cancelled && element.current)
          id = t.render(element.current, {
            sitekey: siteKey,
            action,
            theme: "auto",
            callback: (token: string) => callback.current(token),
            "expired-callback": () => callback.current(""),
            "error-callback": () => {
              callback.current("");
              setError(tr("验证码验证失败，请重新尝试"));
            },
          });
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
      if (id) api?.remove(id);
    };
  }, [siteKey, action, resetKey]);
  return (
    <div className="captcha-widget">
      <div ref={element} />
      {error && (
        <p role="alert" className="field-note">
          {error}
        </p>
      )}
    </div>
  );
}
