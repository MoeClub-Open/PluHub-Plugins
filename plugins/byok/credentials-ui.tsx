import { t as tr, textValue } from "../../lib/ui/i18n.js";
import { Select } from "../../lib/ui/select.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { useLoad, Notice } from "../../lib/ui/mount.js";
import { PageHeading, Dialog, Empty } from "../../lib/ui/components.js";
const api = "/api/plugins/official.byok";
export function LegacyCredentials({ host }: { host: UIHost }) {
  const rows = useLoad<any[]>(() => host.request(api + "/credentials"));
  const channels = useLoad<any[]>(() => host.request(api + "/channels"));
  const platformCredentials = rows.data?.filter(
    (row) => !row.channel.startsWith("personal:"),
  );
  const [dialog, setDialog] = React.useState(false);
  const [kind, setKind] = React.useState("key");
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [revokeTarget, setRevokeTarget] = React.useState<any>();
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    try {
      await host.request(api + "/credentials", {
        method: "POST",
        body: JSON.stringify({
          name: f.get("name"),
          channel: f.get("channel"),
          kind,
          ...(kind === "key"
            ? { key: f.get("key") }
            : { oauth: JSON.parse(String(f.get("oauth"))) }),
        }),
      });
      setDialog(false);
      rows.reload();
      setRevokeTarget(undefined);
      setMessage(tr("凭证已保存"));
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string) {
    setBusy(true);
    try {
      await host.request(api + "/revoke", {
        method: "POST",
        body: JSON.stringify({ id }),
      });
      rows.reload();
      setRevokeTarget(undefined);
      setMessage(tr("凭证已撤销。"));
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading title={tr("平台渠道凭证")} />
      <Notice message={message || rows.error || channels.error} />
      <div className="section-heading">
        <button
          disabled={!channels.data?.length}
          onClick={() => setDialog(true)}
        >
          {tr("添加凭证")}
        </button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{tr("名称")}</th>
              <th>{tr("渠道")}</th>
              <th>{tr("授权类型")}</th>
              <th>{tr("凭证 ID")}</th>
              <th>{tr("操作")}</th>
            </tr>
          </thead>
          <tbody>
            {platformCredentials?.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td>{r.channel}</td>
                <td>{r.kind === "oauth" ? tr("OAuth 订阅授权") : "API Key"}</td>
                <td>
                  <code>{r.id}</code>
                </td>
                <td>
                  <button
                    className="ghost danger"
                    disabled={busy}
                    onClick={() => {
                      setMessage("");
                      setRevokeTarget(r);
                    }}
                  >
                    {tr("撤销")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {platformCredentials?.length === 0 && <Empty title={tr("暂无凭证")} />}
      </div>
      <details className="card">
        <summary>{tr("客户端接入说明")}</summary>

        <pre className="code">
          {tr(
            "Authorization: Bearer <PluHub API Key>\nx-pluhub-credential: <凭证 ID>",
          )}
        </pre>
      </details>
      {revokeTarget && (
        <Dialog
          title={tr("撤销自带凭证")}
          close={() => {
            if (!busy) setRevokeTarget(undefined);
          }}
        >
          <Notice message={message} />
          <p>
            {tr(
              "确定撤销「{0} 」？通过此凭证发起的调用将失效，其他凭证不受影响。",
              { "0": textValue(revokeTarget.name) },
            )}
          </p>
          <div className="form-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setRevokeTarget(undefined)}
            >
              {tr("保留凭证")}
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() => void revoke(revokeTarget.id)}
            >
              {busy ? tr("撤销中…") : tr("确认撤销")}
            </button>
          </div>
        </Dialog>
      )}
      {dialog && (
        <Dialog
          title={tr("添加自带凭证")}
          close={() => {
            if (!busy) setDialog(false);
          }}
        >
          <form onSubmit={save}>
            <Notice message={message} />
            <label>
              {tr("名称")}
              <input name="name" required maxLength={128} autoComplete="off" />
            </label>
            <label>
              {tr("绑定渠道")}
              <Select name="channel">
                {channels.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.protocol}
                  </option>
                ))}
              </Select>
            </label>

            <label>
              {tr("凭证类型")}
              <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="key">API Key / Access Token</option>
                <option value="oauth">{tr("OAuth 授权 JSON")}</option>
              </Select>
            </label>
            {kind === "key" ? (
              <label>
                {tr("密钥")}
                <input
                  name="key"
                  type="password"
                  required
                  autoComplete="new-password"
                />
              </label>
            ) : (
              <label>
                {tr("OAuth 授权")}
                <textarea
                  className="code"
                  name="oauth"
                  rows={7}
                  required
                  placeholder={
                    '{"access_token":"…","expires_at":1790000000000}'
                  }
                />
              </label>
            )}
            <div className="actions">
              <button disabled={busy}>
                {busy ? tr("保存中…") : tr("保存")}
              </button>
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() => setDialog(false)}
              >
                {tr("取消")}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
}
