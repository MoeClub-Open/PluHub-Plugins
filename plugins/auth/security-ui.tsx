import { t as tr, textValue, getLocale } from "../../lib/ui/i18n.js";
import { Select } from "../../lib/ui/select.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { startRegistration } from "@simplewebauthn/browser";
import { useLoad, Notice } from "../../lib/ui/mount.js";
import { Dialog } from "../../lib/ui/components.js";
const api = "/api/plugins/official.auth";
export function Security({ host }: { host: UIHost }) {
  const status = useLoad<any>(() => host.request(api + "/security"));
  const [message, setMessage] = React.useState(""),
    [busy, setBusy] = React.useState(false),
    [setup, setSetup] = React.useState<any>(),
    [codes, setCodes] = React.useState<string[]>([]),
    [email, setEmail] = React.useState(""),
    [emailChallenge, setEmailChallenge] = React.useState("");
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await fn();
      status.reload();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const post = (path: string, body: any = {}) =>
    host.request<any>(api + path, {
      method: "POST",
      body: JSON.stringify(body),
    });
  const s = status.data;
  const [revokeKey, setRevokeKey] = React.useState<any>();
  return (
    <>
      <Notice message={message || status.error} />
      <div className="security-summary card">
        <div>
          <small>{tr("邮箱")}</small>
          <strong>{s?.email ?? tr("尚未验证")}</strong>
        </div>
        <div>
          <small>{tr("验证器")}</small>
          <strong>{s?.totpEnabled ? tr("TOTP 已启用") : tr("尚未绑定")}</strong>
        </div>
        <div>
          <small>{tr("安全密钥 / Passkey")}</small>
          <strong>
            {tr("{0} 个", { "0": textValue(s?.passkeys?.length ?? 0) })}
          </strong>
        </div>
      </div>
      <div className="card">
        <h2>{tr("验证邮箱")}</h2>

        {!s?.mailEnabled ? (
          <p className="muted">{tr("邮箱验证暂不可用，请稍后再试。")}</p>
        ) : (
          <>
            <div className="inline-form">
              <label>
                {tr("邮箱地址")}
                <input
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setEmailChallenge("");
                  }}
                />
              </label>
              <button
                className="secondary"
                disabled={busy || !email}
                onClick={() =>
                  void act(async () => {
                    const result = await post("/email/request", {
                      language: getLocale(),
                      purpose: "bind",
                      email,
                    });
                    setEmailChallenge(result.challenge);
                    setMessage(tr("如邮箱符合条件，验证码已发送"));
                  })
                }
              >
                {tr("发送绑定验证码")}
              </button>
            </div>
            {emailChallenge && (
              <form
                className="inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  void act(async () => {
                    await post("/email/bind", {
                      email,
                      challenge: emailChallenge,
                      code: f.get("code"),
                    });
                    setEmailChallenge("");
                    setMessage(tr("邮箱已验证"));
                  });
                }}
              >
                <label>
                  {tr("邮箱验证码")}
                  <input
                    name="code"
                    required
                    autoComplete="one-time-code"
                    inputMode="numeric"
                  />
                </label>
                <button disabled={busy}>{tr("验证并绑定")}</button>
              </form>
            )}
          </>
        )}
      </div>
      <div className="card">
        <div className="section-heading">
          <h2>{tr("TOTP 两步验证")}</h2>
          <span className={"badge " + (s?.totpEnabled ? "ready" : "")}>
            {s?.totpEnabled ? tr("已启用") : tr("未启用")}
          </span>
        </div>
        <p className="field-note">
          {tr("扫码后输入六位动态码。启用后，密码与邮箱登录需两步验证。")}
        </p>
        {!s?.totpEnabled ? (
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                setSetup(await post("/totp/setup"));
                setCodes([]);
              })
            }
          >
            {tr("绑定验证器")}
          </button>
        ) : (
          <div className="actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const result = await post("/recovery-codes");
                  setCodes(result.recoveryCodes);
                })
              }
            >
              {tr("重新生成恢复码（旧码失效）")}
            </button>
            <button
              className="ghost danger"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await host.request(api + "/totp", { method: "DELETE" });
                  setCodes([]);
                  setMessage(tr("两步验证已关闭"));
                })
              }
            >
              {tr("关闭两步验证")}
            </button>
            <span className="muted">
              {tr("剩余 {0} 条恢复码", {
                "0": textValue(s?.recoveryCodesRemaining ?? 0),
              })}
            </span>
          </div>
        )}
        {setup && !s?.totpEnabled && (
          <div className="totp-enrollment">
            <img
              width="240"
              height="240"
              src={setup.qrDataURL}
              alt={tr("验证器绑定二维码")}
            />
            <div>
              <p>
                {tr("手动输入密钥：")}
                <code className="secret-value">{setup.secret}</code>
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  void act(async () => {
                    const result = await post("/totp/confirm", {
                      challenge: setup.challenge,
                      code: f.get("code"),
                    });
                    setSetup(undefined);
                    setCodes(result.recoveryCodes);
                    setMessage(tr("验证器已绑定，其他会话已退出"));
                  });
                }}
              >
                <label>
                  {tr("验证器动态码")}
                  <input
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    required
                  />
                </label>
                <button disabled={busy}>{tr("验证并启用")}</button>
              </form>
            </div>
          </div>
        )}
        {codes.length > 0 && (
          <div className="notice">
            <strong>{tr("保存一次性恢复码")}</strong>
            <p>{tr("恢复码仅显示一次，每条只能使用一次，请妥善保存。")}</p>
            <pre>{codes.join("\n")}</pre>
            <button
              className="secondary"
              onClick={() => {
                void navigator.clipboard.writeText(codes.join("\n")).then(
                  () => setMessage(tr("恢复码已复制")),
                  () => setMessage(tr("请手动保存恢复码")),
                );
              }}
            >
              {tr("复制恢复码")}
            </button>
            <button className="secondary" onClick={() => setCodes([])}>
              {tr("已保存，隐藏")}
            </button>
          </div>
        )}
      </div>
      <div className="card">
        <h2>{tr("Passkey 与 FIDO2 安全密钥")}</h2>

        {s?.webauthnEnabled ? (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget,
                f = new FormData(form);
              void act(async () => {
                const start = await post(
                  "/passkeys/register/options",
                  Object.fromEntries(f),
                );
                const response = await startRegistration({
                  optionsJSON: start.options,
                });
                await post("/passkeys/register/verify", {
                  challenge: start.challenge,
                  response,
                });
                form.reset();
                setMessage(tr("安全凭据已绑定"));
              });
            }}
          >
            <label>
              {tr("凭据名称")}
              <input
                name="name"
                required
                maxLength={128}
                placeholder={tr("我的设备或安全密钥")}
              />
            </label>
            <label>
              {tr("绑定方式")}
              <Select name="kind">
                <option value="passkey">
                  {tr("Passkey（设备或密码管理器）")}
                </option>
                <option value="hardware">{tr("外接 FIDO2 安全密钥")}</option>
              </Select>
            </label>
            <button disabled={busy}>{tr("添加安全凭据")}</button>
          </form>
        ) : (
          <p className="muted">{tr("本站暂不支持 Passkey 与安全密钥登录。")}</p>
        )}
        {(s?.webauthnEnabled || !!s?.passkeys?.length) && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{tr("名称")}</th>
                  <th>{tr("设备类型")}</th>
                  <th>{tr("最近使用")}</th>
                  <th>{tr("操作")}</th>
                </tr>
              </thead>
              <tbody>
                {s?.passkeys?.map((key: any) => (
                  <tr key={key.id}>
                    <td>{key.name}</td>
                    <td>
                      {key.device_type === "multiDevice"
                        ? tr("可同步")
                        : tr("单设备")}
                      {key.backed_up ? tr(" · 已备份") : ""}
                    </td>
                    <td>
                      {key.last_used_at
                        ? new Date(key.last_used_at).toLocaleString(getLocale())
                        : tr("尚未使用")}
                    </td>
                    <td>
                      <button
                        className="ghost danger"
                        disabled={busy}
                        onClick={() => {
                          setMessage("");
                          setRevokeKey(key);
                        }}
                      >
                        {tr("撤销")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!s?.passkeys?.length && (
              <p className="empty-inline">{tr("还没有绑定安全密钥。")}</p>
            )}
          </div>
        )}
      </div>
      {revokeKey && (
        <Dialog
          title={tr("撤销安全凭据")}
          close={() => {
            if (!busy) setRevokeKey(undefined);
          }}
        >
          <Notice message={message} />
          <p>
            {tr(
              "确定撤销「{0} 」？此凭据将无法再次登录，使用它建立的会话也会退出。",
              { "0": textValue(revokeKey.name) },
            )}
          </p>
          <div className="form-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setRevokeKey(undefined)}
            >
              {tr("保留凭据")}
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await host.request(
                    api + "/passkeys?id=" + encodeURIComponent(revokeKey.id),
                    { method: "DELETE" },
                  );
                  setRevokeKey(undefined);
                  setMessage(tr("凭据已撤销，使用此凭据建立的会话已退出"));
                  host.refresh();
                })
              }
            >
              {tr("确认撤销")}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
