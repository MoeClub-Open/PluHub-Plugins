import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import type { SubscriptionKind } from "../ai/subscription-auth.js";
import { Dialog, Icon } from "./components.js";
import { Notice, useLoad } from "./mount.js";
import { Select } from "./select.js";
import { t as tr } from "./i18n.js";

const providers: Record<SubscriptionKind, string> = {
  codex: "Codex",
  "claude-subscription": "Claude",
  antigravity: "Antigravity",
};
type Flow = {
  id: string;
  url: string;
  mode: "device" | "callback" | "manual";
  userCode?: string;
  expiresAt: number;
  retryAfterMs?: number;
};
type Provider = {
  provider: SubscriptionKind;
  ready: boolean;
  device: boolean;
  automatic: boolean;
};

export function SubscriptionEditor({
  host,
  account,
  close,
  saved,
  api,
  provider: fixedProvider,
}: {
  host: UIHost;
  api: string;
  provider: SubscriptionKind;
  account?: any;
  close: () => void;
  saved: () => void;
}) {
  const available = useLoad<Provider[]>(() =>
    host.request(api + "/oauth/providers"),
  );
  const [provider, setProvider] =
    React.useState<SubscriptionKind>(fixedProvider);
  const [name, setName] = React.useState(account?.name ?? "");
  const [maxConcurrency, setMax] = React.useState(account?.maxConcurrency ?? 2);
  const [authorization, setAuthorization] = React.useState("");
  const [projectId, setProject] = React.useState(account?.projectId ?? "");
  const [tab, setTab] = React.useState(account ? "details" : "login");
  const [method, setMethod] = React.useState("");
  const [flow, setFlow] = React.useState<Flow>();
  const [callback, setCallback] = React.useState("");
  const [busy, setBusy] = React.useState(false),
    [message, setMessage] = React.useState("");
  const current = React.useRef<Flow | undefined>(undefined);
  const alive = React.useRef(true);
  const popup = React.useRef<Window | null>(null);
  const profile = available.data?.find((p) => p.provider === provider);
  const selectedMethod = method || (profile?.device ? "device" : "browser");
  const input = {
    id: account?.id,
    provider,
    name: name.trim() || providers[provider],
    maxConcurrency,
  };
  const cancel = React.useCallback(async () => {
    const previous = current.current;
    current.current = undefined;
    popup.current?.close();
    popup.current = null;
    if (previous)
      await host
        .request(api + "/oauth/cancel", {
          method: "POST",
          body: JSON.stringify({ id: previous.id }),
        })
        .catch(() => {});
  }, [host, api]);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      void cancel();
    };
  }, [cancel]);
  async function done(result: any) {
    current.current = undefined;
    popup.current?.close();
    popup.current = null;
    if (
      provider === "antigravity" &&
      projectId &&
      projectId !== result.projectId
    )
      await host.request(api + "/account", {
        method: "POST",
        body: JSON.stringify({ id: result.id, action: "project", projectId }),
      });
    if (alive.current) {
      saved();
      close();
    }
  }
  React.useEffect(() => {
    if (!flow || flow.mode === "manual") return;
    let gone = false,
      timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        if (Date.now() >= flow!.expiresAt)
          throw new Error(tr("授权会话已过期，请重新开始"));
        const result: any = await host.request(api + "/oauth/status", {
          method: "POST",
          body: JSON.stringify({ id: flow!.id }),
        });
        if (gone) return;
        if (result.status === "complete") {
          await done(result.account);
          return;
        }
        timer = setTimeout(
          () => void poll(),
          Math.min(300000, Math.max(1000, result.retryAfterMs ?? 1500)),
        );
      } catch (error) {
        if (!gone) {
          setMessage((error as Error).message);
          setBusy(false);
        }
      }
    }
    timer = setTimeout(() => void poll(), flow.retryAfterMs ?? 1500);
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [flow]);
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await work();
    } catch (error) {
      if (alive.current) setMessage((error as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function start() {
    popup.current = window.open(
      "about:blank",
      "_blank",
      "popup,width=620,height=760",
    );
    if (popup.current) popup.current.opener = null;
    await run(async () => {
      try {
        const next = await host.request<Flow>(api + "/oauth/start", {
          method: "POST",
          body: JSON.stringify({ ...input, mode: selectedMethod }),
        });
        current.current = next;
        if (!alive.current) {
          await cancel();
          return;
        }
        setFlow(next);
        setAuthorization("");
        if (popup.current) popup.current.location.href = next.url;
      } catch (error) {
        popup.current?.close();
        popup.current = null;
        throw error;
      }
    });
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    await run(async () => {
      const result = flow
        ? await host.request(api + "/oauth/finish", {
            method: "POST",
            body: JSON.stringify({ id: flow.id, callback }),
          })
        : tab === "import"
          ? await host.request(api + "/accounts", {
              method: "POST",
              body: JSON.stringify({ ...input, authorization }),
            })
          : await host.request(api + "/account", {
              method: "POST",
              body: JSON.stringify({
                id: account.id,
                action: "update",
                name,
                maxConcurrency,
              }),
            });
      setAuthorization("");
      setCallback("");
      await done(result);
    });
  }
  return (
    <Dialog
      title={account ? tr("编辑订阅账号") : tr("添加订阅账号")}
      close={close}
    >
      <form className="subscription-form" onSubmit={save}>
        <Notice message={message || available.error} />
        {!flow && (
          <div className="tabs" role="tablist" aria-label={tr("账号接入方式")}>
            {(account
              ? [
                  ["details", tr("账号设置")],
                  ["login", tr("重新授权")],
                  ["import", tr("导入授权")],
                ]
              : [
                  ["login", tr("OAuth 登录")],
                  ["import", tr("导入授权")],
                ]
            ).map(([id, title]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={tab === id ? "active" : ""}
                disabled={busy}
                onClick={() => {
                  setTab(id!);
                  setMessage("");
                }}
              >
                {title}
              </button>
            ))}
          </div>
        )}
        <div className="form-grid">
          <label>
            {tr("名称")}
            <input
              maxLength={128}
              value={name}
              placeholder={providers[provider]}
              required={tab === "details"}
              disabled={!!flow}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            {tr("提供商")}
            <Select
              value={provider}
              disabled
              onChange={(e) => {
                setProvider(e.target.value as SubscriptionKind);
                setMethod("");
                setAuthorization("");
                setMessage("");
              }}
            >
              {Object.entries(providers).map(([id, title]) => (
                <option key={id} value={id}>
                  {title}
                </option>
              ))}
            </Select>
          </label>
          <label>
            {tr("最大并发")}
            <input
              required
              type="number"
              min={1}
              max={100}
              value={maxConcurrency}
              disabled={!!flow}
              onChange={(e) => setMax(Number(e.target.value))}
            />
          </label>
          {provider === "antigravity" && (
            <label>
              Project ID
              <input
                value={projectId}
                onChange={(e) => setProject(e.target.value)}
              />
            </label>
          )}
          {!flow && tab === "login" && profile?.device && (
            <label>
              {tr("授权方式")}
              <Select
                value={selectedMethod}
                onChange={(e) => setMethod(e.target.value)}
              >
                <option value="device">{tr("设备授权")}</option>
                <option value="browser">{tr("浏览器授权")}</option>
              </Select>
            </label>
          )}
        </div>
        {flow ? (
          <div className="oauth-connect">
            {flow.mode === "device" && (
              <>
                <label>
                  {tr("一次性授权码")}
                  <input
                    aria-label={tr("一次性授权码")}
                    readOnly
                    value={flow.userCode}
                    className="oauth-device-code"
                  />
                </label>
                <p>{tr("在授权页面输入此码，完成后会自动连接。")}</p>
              </>
            )}
            <a
              className="button secondary"
              href={flow.url}
              target="_blank"
              rel="noreferrer"
            >
              {tr("打开授权页面")}
              <Icon name="arrow" size={14} />
            </a>
            {flow.mode === "manual" ? (
              <>
                <label>
                  {tr("授权码或回调地址")}
                  <textarea
                    required
                    autoComplete="off"
                    spellCheck={false}
                    value={callback}
                    onChange={(e) => setCallback(e.target.value)}
                  />
                </label>
                <p className="muted">
                  {tr(
                    "完成提供商登录后，粘贴授权码（code#state）或完整回调地址。",
                  )}
                </p>
              </>
            ) : (
              <p role="status" className="muted">
                {tr("等待授权完成…")}
              </p>
            )}
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await cancel();
                  setFlow(undefined);
                  setCallback("");
                })
              }
            >
              {tr("重新开始")}
            </button>
          </div>
        ) : tab === "login" ? (
          <>
            {profile && !profile.ready && (
              <Notice
                message={tr("请先配置 Antigravity OAuth 客户端密钥引用")}
              />
            )}
            <button
              type="button"
              disabled={busy || !profile?.ready}
              onClick={() => void start()}
            >
              <Icon name="key" size={15} />
              {tr("连接 {0}", { "0": providers[provider] })}
            </button>
          </>
        ) : tab === "import" ? (
          <label>
            {tr("授权 JSON")}
            <textarea
              required
              aria-label={tr("授权 JSON")}
              autoComplete="off"
              spellCheck={false}
              value={authorization}
              onChange={(e) => setAuthorization(e.target.value)}
            />
          </label>
        ) : null}
        <div className="actions">
          <button
            type="button"
            className="secondary"
            onClick={close}
            disabled={busy}
          >
            {tr("取消")}
          </button>
          {(flow?.mode === "manual" || (!flow && tab !== "login")) && (
            <button disabled={busy}>
              {flow ? tr("完成授权") : tr("保存")}
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
