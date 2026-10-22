import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { useLoad, Notice } from "../../lib/ui/mount.js";
import { Dialog } from "../../lib/ui/components.js";
import { t as tr, getLocale } from "../../lib/ui/i18n.js";
export function Sessions({ host }: { host: UIHost }) {
  const data = useLoad<{ items: any[] }>(() =>
    host.request("/api/plugins/official.auth/sessions"),
  );
  const [target, setTarget] = React.useState<any>();
  const [busy, setBusy] = React.useState(false),
    [message, setMessage] = React.useState("");
  async function revoke() {
    setBusy(true);
    setMessage("");
    try {
      const result = await host.request<any>(
        "/api/plugins/official.auth/sessions/" +
          (target === "others" ? "revoke-others" : "revoke"),
        {
          method: "POST",
          body: JSON.stringify(target === "others" ? {} : { id: target.id }),
        },
      );
      setTarget(undefined);
      if (result.current) {
        host.navigate("/login");
        host.refresh();
        return;
      }
      data.reload();
      setMessage(tr("登录设备已退出"));
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const time = (value: number) =>
    value ? new Date(value).toLocaleString(getLocale()) : "—";
  const deviceName = (agent: string) => {
    const browser = /Edg\//.test(agent)
      ? "Edge"
      : /Firefox\//.test(agent)
        ? "Firefox"
        : /Chrome\//.test(agent)
          ? "Chrome"
          : /Safari\//.test(agent)
            ? "Safari"
            : "";
    const os = /Android/.test(agent)
      ? "Android"
      : /iPhone|iPad/.test(agent)
        ? "iOS"
        : /Windows/.test(agent)
          ? "Windows"
          : /Mac OS/.test(agent)
            ? "macOS"
            : /Linux/.test(agent)
              ? "Linux"
              : "";
    return browser
      ? [browser, os].filter(Boolean).join(" · ")
      : agent.length <= 80
        ? agent
        : tr("未知浏览器");
  };
  return (
    <section className="card">
      <div className="section-heading">
        <h2>{tr("登录设备")}</h2>
        <button
          className="secondary"
          disabled={!data.data || data.data.items.length < 2 || busy}
          onClick={() => setTarget("others")}
        >
          {tr("退出其他设备")}
        </button>
      </div>
      <Notice message={message || data.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{tr("设备")}</th>
              <th>{tr("最近活动")}</th>
              <th>{tr("操作")}</th>
            </tr>
          </thead>
          <tbody>
            {data.data?.items.map((item) => (
              <tr key={item.id}>
                <td>
                  <strong>
                    {item.current ? tr("当前设备") : tr("其他设备")}
                  </strong>
                  <small
                    title={item.device}
                    style={{
                      maxWidth: 360,
                      whiteSpace: "normal",
                      overflowWrap: "anywhere",
                    }}
                  >
                    {item.device
                      ? deviceName(item.device)
                      : tr("设备信息不可用")}
                  </small>
                  <small>
                    {item.ip || "—"} ·{" "}
                    {tr(
                      (
                        {
                          password: "密码",
                          email: "邮箱",
                          mfa: "多因素验证",
                          passkey: "Passkey",
                          legacy: "登录",
                        } as Record<string, string>
                      )[item.method] ?? "登录",
                    )}
                  </small>
                </td>
                <td>
                  {time(item.last_active_at)}
                  <small>
                    {tr("到期时间")} {time(item.expires)}
                  </small>
                </td>
                <td>
                  <button
                    className="ghost danger"
                    onClick={() => setTarget(item)}
                    disabled={busy}
                  >
                    {tr("退出设备")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {target && (
        <Dialog
          title={tr("退出登录设备")}
          close={() => {
            if (!busy) setTarget(undefined);
          }}
        >
          <p>
            {target === "others"
              ? tr("保留当前设备，退出此账号的其他登录设备。")
              : target.current
                ? tr("将退出当前设备，需要重新登录。")
                : tr("该设备将立即失去账号访问权限。")}
          </p>
          <Notice message={message} />
          <div className="actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setTarget(undefined)}
            >
              {tr("取消")}
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() => void revoke()}
            >
              {tr("确认退出")}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
