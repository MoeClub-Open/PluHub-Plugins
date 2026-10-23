import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import type { SubscriptionKind } from "../ai/subscription-auth.js";
import { Dialog, Icon } from "./components.js";
import { Notice } from "./mount.js";
import { t as tr } from "./i18n.js";
import { Select } from "./select.js";

const providers: Record<SubscriptionKind, string> = {
  codex: "Codex",
  "claude-subscription": "Claude",
  antigravity: "Antigravity",
  grok: "Grok",
};
type Flow = {
  id: string;
  url: string;
  expiresAt: number;
  mode?: string;
  userCode?: string;
  retryAfterMs?: number;
};

export function SubscriptionEditor({
  host,
  account,
  close,
  saved,
  api,
  provider,
}: {
  host: UIHost;
  api: string;
  provider: SubscriptionKind;
  account?: any;
  close: () => void;
  saved: () => void;
}) {
  const [name, setName] = React.useState(account?.name ?? "");
  const [maxConcurrency, setMax] = React.useState(account?.maxConcurrency ?? 2);
  const [authorization, setAuthorization] = React.useState("");
  const [projectId, setProject] = React.useState(account?.projectId ?? "");
  const [tab, setTab] = React.useState(account ? "details" : "login");
  const [flow, setFlow] = React.useState<Flow>();
  const [authMode, setAuthMode] = React.useState(account?.authMode ?? "cli");
  const [callback, setCallback] = React.useState("");
  const [copied, setCopied] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const current = React.useRef<Flow | undefined>(undefined);
  const alive = React.useRef(true);
  const input = {
    id: account?.id,
    provider,
    name: name.trim(),
    maxConcurrency,
    authMode,
  };
  const cancel = React.useCallback(async () => {
    const previous = current.current;
    current.current = undefined;
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
  React.useEffect(() => {
    if (flow?.mode !== "device") return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await host.request<any>(api + "/oauth/status", {
          method: "POST",
          body: JSON.stringify({ id: flow.id }),
        });
        if (stopped || current.current?.id !== flow.id) return;
        if (result.status === "complete") {
          await done(result.account);
          return;
        }
        timer = setTimeout(poll, Math.max(1000, result.retryAfterMs ?? 5000));
      } catch (error) {
        if (!stopped) setMessage((error as Error).message);
      }
    };
    timer = setTimeout(poll, flow.retryAfterMs ?? 5000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [flow, host, api]);
  async function done(result: any) {
    current.current = undefined;
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
  async function authorize(action: "copy" | "open") {
    const opened =
      action === "open" ? window.open("about:blank", "_blank") : null;
    if (opened) opened.opener = null;
    await run(async () => {
      try {
        let next = current.current;
        if (!next || next.expiresAt <= Date.now()) {
          await cancel();
          next = await host.request<Flow>(api + "/oauth/start", {
            method: "POST",
            body: JSON.stringify({
              ...input,
              mode: provider === "grok" ? "device" : "manual",
            }),
          });
          current.current = next;
          if (!alive.current) {
            await cancel();
            opened?.close();
            return;
          }
          setFlow(next);
          setCallback("");
          setCopied(false);
        }
        if (action === "copy") {
          await navigator.clipboard.writeText(next.url);
          if (alive.current) setCopied(true);
        } else if (opened) opened.location.replace(next.url);
        else throw new Error(tr("无法打开新标签页，请复制授权链接。"));
      } catch (error) {
        opened?.close();
        throw error;
      }
    });
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (tab === "login" && !flow) return;
    await run(async () => {
      const result = flow
        ? await host.request(api + "/oauth/finish", {
            method: "POST",
            body: JSON.stringify({ id: flow.id, callback: callback.trim() }),
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
      title={
        providers[provider] +
        " · " +
        (account ? tr("编辑订阅账号") : tr("添加订阅账号"))
      }
      close={close}
    >
      <form className="subscription-form" onSubmit={save}>
        <Notice message={message} />
        {!flow && (
          <div className="tabs" role="tablist" aria-label={tr("账号接入方式")}>
            {(account
              ? [
                  ["details", tr("账号设置")],
                  ["login", tr("重新授权")],
                  ["import", tr("导入授权")],
                ]
              : [
                  ["login", tr("登录授权")],
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
          {provider === "codex" && tab === "login" && !flow && (
            <label>
              {tr("授权方式")}
              <Select
                value={authMode}
                disabled={!!account}
                onChange={(e) => setAuthMode(e.target.value)}
              >
                <option value="cli">Codex CLI</option>
                <option value="siwc">Continue with ChatGPT (SIWC)</option>
              </Select>
            </label>
          )}
          <label>
            {tr("名称")}
            <input
              maxLength={254}
              value={name}
              placeholder={tr("自动获取邮箱")}
              disabled={!!flow || busy}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            {tr("最大并发")}
            <input
              required
              type="number"
              min={1}
              max={100}
              value={maxConcurrency}
              disabled={!!flow || busy}
              onChange={(event) => setMax(Number(event.target.value))}
            />
          </label>
          {provider === "antigravity" && (
            <label>
              Project ID
              <input
                value={projectId}
                disabled={busy}
                onChange={(event) => setProject(event.target.value)}
              />
            </label>
          )}
        </div>
        {tab === "login" && (
          <div className="oauth-connect">
            {flow?.mode === "device" && (
              <label>
                {tr("设备验证码")}
                <input
                  readOnly
                  value={flow.userCode}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <span role="status">{tr("等待授权…")}</span>
              </label>
            )}
            {flow && flow.mode !== "device" && (
              <label>
                {tr("授权链接")}
                <input
                  readOnly
                  value={flow.url}
                  spellCheck={false}
                  autoComplete="off"
                  onFocus={(event) => event.currentTarget.select()}
                />
              </label>
            )}
            <div className="actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void authorize("copy")}
              >
                <Icon name="copy" size={14} />
                {copied ? tr("已复制") : tr("复制授权链接")}
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void authorize("open")}
              >
                {tr("打开授权页面")}
                <Icon name="arrow" size={14} />
              </button>
            </div>
            {flow && (
              <>
                <label>
                  {tr("回调链接或授权码")}
                  <textarea
                    required
                    rows={2}
                    autoComplete="off"
                    spellCheck={false}
                    value={callback}
                    disabled={busy}
                    onChange={(event) => setCallback(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await cancel();
                      setFlow(undefined);
                      setCallback("");
                      setCopied(false);
                    })
                  }
                >
                  {tr("重新开始")}
                </button>
              </>
            )}
          </div>
        )}
        {tab === "import" && (
          <label>
            {tr("授权 JSON")}
            <textarea
              required
              aria-label={tr("授权 JSON")}
              autoComplete="off"
              spellCheck={false}
              value={authorization}
              disabled={busy}
              onChange={(event) => setAuthorization(event.target.value)}
            />
          </label>
        )}
        <div className="actions">
          <button
            type="button"
            className="secondary"
            onClick={close}
            disabled={busy}
          >
            {tr("取消")}
          </button>
          {((flow && flow.mode !== "device") || tab !== "login") && (
            <button disabled={busy}>
              {flow ? tr("完成授权") : tr("保存")}
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
