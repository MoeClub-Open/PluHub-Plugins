import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { startAuthentication } from "@simplewebauthn/browser";
import { Dialog } from "../../lib/ui/components.js";
import { Notice, useLoad } from "../../lib/ui/mount.js";
import { t as tr } from "../../lib/ui/i18n.js";

const api = "/api/plugins/official.auth";

export function IdentityConfirmation({
  client,
  complete,
  close,
}: {
  client: UIHost;
  complete: () => void;
  close: () => void;
}) {
  const security = useLoad<any>(() => client.request(api + "/security"));
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [recovery, setRecovery] = React.useState(false);
  const content = React.useRef<HTMLDivElement>(null);
  const [controller] = React.useState(() => new AbortController());
  React.useEffect(() => () => controller.abort(), [controller]);
  React.useLayoutEffect(() => {
    const layers = Array.from(
      document.querySelectorAll<HTMLElement>(".dialog-layer"),
    )
      .filter((layer) => !layer.contains(content.current))
      .map((layer) => ({ layer, inert: layer.inert }));
    for (const { layer } of layers) layer.inert = true;
    return () => {
      for (const { layer, inert } of layers) layer.inert = inert;
    };
  }, []);
  const post = (path: string, body: unknown) =>
    client.request<any>(api + path, {
      method: "POST",
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  async function verify(action: () => Promise<unknown>) {
    setBusy(true);
    setMessage("");
    try {
      await action();
      if (!controller.signal.aborted) complete();
    } catch (error) {
      if (!controller.signal.aborted) setMessage((error as Error).message);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <Dialog title={tr("验证身份")} close={close}>
      <div ref={content}>
        <Notice message={message || security.error} />
        {security.data?.passwordSet !== false && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const fields = Object.fromEntries(
                new FormData(event.currentTarget),
              );
              void verify(() => post("/reauth", fields));
            }}
          >
            <label>
              {tr("当前密码")}
              <input
                name="password"
                type="password"
                required
                autoFocus
                autoComplete="current-password"
                disabled={busy}
              />
            </label>
            {security.data?.totpEnabled && (
              <label>
                {recovery ? tr("一次性恢复码") : tr("验证器动态码")}
                <input
                  key={recovery ? "recovery" : "totp"}
                  name={recovery ? "recoveryCode" : "code"}
                  required
                  inputMode={recovery ? "text" : "numeric"}
                  autoComplete="one-time-code"
                  disabled={busy}
                />
                <button
                  type="button"
                  className="ghost"
                  disabled={busy}
                  onClick={() => setRecovery((value) => !value)}
                >
                  {recovery ? tr("验证器动态码") : tr("使用恢复码")}
                </button>
              </label>
            )}
            <div className="form-actions">
              <button type="button" className="secondary" onClick={close}>
                {tr("取消")}
              </button>
              <button disabled={busy || !security.data}>{tr("确认")}</button>
            </div>
          </form>
        )}
        {!!security.data?.passkeys?.length && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() =>
              void verify(async () => {
                const start = await post("/passkeys/reauth/options", {});
                const response = await startAuthentication({
                  optionsJSON: start.options,
                });
                controller.signal.throwIfAborted();
                await post("/passkeys/reauth/verify", {
                  challenge: start.challenge,
                  response,
                });
              })
            }
          >
            {tr("使用 Passkey / 安全密钥验证")}
          </button>
        )}
      </div>
    </Dialog>
  );
}
