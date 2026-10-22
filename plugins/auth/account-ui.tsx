import { t as tr } from "../../lib/ui/i18n.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { useLoad, Notice } from "../../lib/ui/mount.js";
import { PageHeading } from "../../lib/ui/components.js";
import { Security } from "./security-ui.js";
import { Sessions } from "./sessions-ui.js";
import { LanguagePicker } from "../../lib/ui/language.js";
import { SecurityHistory } from "../../lib/ui/security-history.js";
export function Account({ host }: { host: UIHost }) {
  const currentTab = () => {
    const value =
      new URLSearchParams(location.hash.split("?")[1]).get("tab") ?? "security";
    return ["security", "sessions", "history"].includes(value)
      ? value
      : "security";
  };
  const [tab, setTab] = React.useState(currentTab);
  React.useEffect(() => {
    const changed = () => setTab(currentTab());
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  const me = useLoad<any>(() => host.request("/api/plugins/official.auth/me"));
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  return (
    <>
      <PageHeading title={tr("账号设置")} />
      <Notice message={message || me.error} />
      <section className="account-profile panel">
        <div>
          <small>{tr("用户名")}</small>
          <strong>{me.data?.username ?? "—"}</strong>
        </div>
        <div>
          <small>{tr("身份")}</small>
          <strong>
            {me.data?.role === "admin" ? tr("管理员") : tr("非管理员")}
          </strong>
        </div>
        <a className="text-link" href="#/auth">
          {tr("管理 API 密钥 →")}
        </a>
      </section>
      <section className="card">
        <h2>{tr("偏好设置")}</h2>
        <label>
          {tr("界面语言")}
          <LanguagePicker />
        </label>
      </section>
      <nav className="tabs" aria-label={tr("账号安全设置")}>
        {[
          ["security", "安全设置"],
          ["sessions", "登录设备"],
          ["history", "安全记录"],
        ].map(([id, label]) => (
          <a
            key={id}
            className={tab === id ? "active" : ""}
            href={"#/account?tab=" + id}
          >
            {tr(label!)}
          </a>
        ))}
      </nav>
      {tab === "history" ? (
        <SecurityHistory host={host} />
      ) : tab === "sessions" ? (
        <Sessions host={host} />
      ) : (
        <>
          <Security host={host} />
          <details className="card">
            <summary>{tr("修改登录密码")}</summary>
            <p className="field-note">{tr("修改后需要重新登录。")}</p>
            <form
              className="form-grid"
              onSubmit={async (e) => {
                e.preventDefault();
                const fields = new FormData(e.currentTarget);
                if (fields.get("password") !== fields.get("confirmation")) {
                  setMessage(tr("两次输入的密码不一致。"));
                  return;
                }
                setBusy(true);
                setMessage("");
                try {
                  await host.request("/api/plugins/official.auth/password", {
                    method: "POST",
                    body: JSON.stringify({
                      currentPassword: fields.get("currentPassword"),
                      password: fields.get("password"),
                    }),
                  });
                  host.navigate("/login");
                  host.refresh();
                } catch (error) {
                  setMessage((error as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                {tr("当前密码")}
                <input
                  name="currentPassword"
                  type="password"
                  autoComplete="current-password"
                  required
                  disabled={busy}
                />
              </label>
              <label>
                {tr("新密码")}
                <input
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={1024}
                  required
                  disabled={busy}
                />
              </label>
              <label>
                {tr("确认新密码")}
                <input
                  name="confirmation"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={1024}
                  required
                  disabled={busy}
                />
              </label>
              <div className="form-actions">
                <button disabled={busy}>
                  {busy ? tr("保存中…") : tr("保存并重新登录")}
                </button>
              </div>
            </form>
          </details>
        </>
      )}
    </>
  );
}
