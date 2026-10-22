import { t as tr, textValue, getLocale } from "../../lib/ui/i18n.js";
import { Select } from "../../lib/ui/select.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { ChannelBinding } from "./channel-binding-ui.js";
import { useLoad, Notice } from "../../lib/ui/mount.js";
import {
  PageHeading,
  Dialog,
  Icon,
  ListPagination,
} from "../../lib/ui/components.js";
const api = "/api/plugins/official.auth/keys";
type Key = {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  models?: string[];
  requests_per_minute: number;
  expires_at?: number;
  last_used_at?: number;
  channel_id?: string;
  credential_id?: string;
};
export function Keys({ host }: { host: UIHost }) {
  const keys = useLoad<Key[]>(() => host.request(api));
  const [query, setQuery] = React.useState("");
  const [status, setStatus] = React.useState("all");
  const [page, setPage] = React.useState(1),
    [size, setSize] = React.useState(10);
  const [dialog, setDialog] = React.useState(
      new URLSearchParams(location.hash.split("?")[1]).get("create") === "1",
    ),
    [revoke, setRevoke] = React.useState<Key>();
  const [token, setToken] = React.useState(""),
    [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [binding, setBinding] = React.useState<Key>();
  const channelNames = useLoad<any[]>(() =>
    host.request("/api/plugins/official.ai-router/channels").catch(() => []),
  );
  const initialChannel =
    new URLSearchParams(location.hash.split("?")[1]).get("channel") ?? "";
  const expired = (key: Key) =>
    !!key.expires_at && key.expires_at <= Date.now();
  const rows = (keys.data ?? []).filter(
    (key) =>
      [key.name, key.prefix, ...(key.models ?? [])]
        .join(" ")
        .toLowerCase()
        .includes(query.trim().toLowerCase()) &&
      (status === "all" || expired(key) === (status === "expired")),
  );
  const current = Math.min(page, Math.max(1, Math.ceil(rows.length / size)));
  const close = () => {
    if (!busy) {
      setDialog(false);
      setToken("");
      setMessage("");
    }
  };
  return (
    <>
      <PageHeading title={tr("API 密钥")}>
        <button
          className="secondary"
          aria-label={tr("刷新密钥")}
          title={tr("刷新密钥")}
          onClick={keys.reload}
        >
          <Icon name="refresh" size={15} />
        </button>
        <button
          onClick={() => {
            setMessage("");
            setDialog(true);
          }}
        >
          <Icon name="plus" size={15} />
          {tr("创建密钥")}
        </button>
      </PageHeading>
      {!dialog && !revoke && !binding && (
        <Notice message={message || keys.error} />
      )}
      <div className="list-toolbar">
        <input
          type="search"
          aria-label={tr("搜索密钥")}
          placeholder={tr("搜索名称、前缀或模型")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
        />
        <Select
          aria-label={tr("密钥状态")}
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="all">{tr("全部状态")}</option>
          <option value="active">{tr("有效")}</option>
          <option value="expired">{tr("已过期")}</option>
        </Select>
        <span className="muted">
          {tr("{0} 个密钥", { "0": textValue(keys.data?.length ?? 0) })}
        </span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{tr("名称 / 前缀")}</th>
              <th>{tr("访问范围")}</th>
              <th>{tr("状态 / 到期时间")}</th>
              <th>{tr("最近使用")}</th>
              <th>{tr("创建时间")}</th>
              <th>{tr("操作")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice((current - 1) * size, current * size).map((key) => (
              <tr key={key.id}>
                <td>
                  <strong>{key.name}</strong>
                  <small>
                    <code>{key.prefix}…</code>
                  </small>
                </td>
                <td>
                  {key.models?.length ? key.models.join(", ") : tr("全部模型")}
                  <small>
                    {key.channel_id
                      ? (channelNames.data?.find((c) => c.id === key.channel_id)
                          ?.name ?? tr("绑定渠道不可用"))
                      : tr("平台默认路由")}
                    {key.credential_id ? tr(" · 自带凭证") : ""}
                  </small>
                  <small>
                    {key.requests_per_minute
                      ? tr("{0} 次 / 分钟", {
                          "0": textValue(key.requests_per_minute),
                        })
                      : tr("不限请求频率")}
                  </small>
                </td>
                <td>
                  <span
                    className={"badge " + (expired(key) ? "error" : "ready")}
                  >
                    {expired(key) ? tr("已过期") : tr("有效")}
                  </span>
                  <small>
                    {key.expires_at
                      ? new Date(key.expires_at).toLocaleString(getLocale())
                      : tr("长期有效")}
                  </small>
                </td>
                <td>
                  {key.last_used_at
                    ? new Date(key.last_used_at).toLocaleString(getLocale())
                    : tr("尚未使用")}
                </td>
                <td>{new Date(key.created_at).toLocaleString(getLocale())}</td>
                <td>
                  <button
                    className="ghost"
                    onClick={() => {
                      setMessage("");
                      setBinding(key);
                    }}
                  >
                    {tr("渠道绑定")}
                  </button>
                  <button
                    className="ghost danger"
                    onClick={() => {
                      setMessage("");
                      setRevoke(key);
                    }}
                  >
                    {tr("撤销")}
                  </button>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={6} className="empty-inline">
                  {keys.data
                    ? keys.data.length
                      ? tr("没有匹配的密钥，可调整搜索或状态筛选。")
                      : tr("暂无 API 密钥")
                    : keys.error
                      ? tr("密钥加载失败，请刷新重试。")
                      : tr("正在加载密钥…")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <ListPagination
        total={rows.length}
        page={current}
        size={size}
        setPage={setPage}
        setSize={setSize}
      />
      {dialog && (
        <Dialog
          title={token ? tr("保存新密钥") : tr("创建 API 密钥")}
          close={close}
        >
          <Notice message={message} />
          {token ? (
            <>
              <p>{tr("完整密钥仅显示这一次。关闭前请复制保存。")}</p>
              <pre className="issued-token">{token}</pre>
              <div className="form-actions">
                <button
                  className="secondary"
                  onClick={() =>
                    void navigator.clipboard.writeText(token).then(
                      () => setMessage(tr("密钥已复制")),
                      () => setMessage(tr("复制失败，请手动保存。")),
                    )
                  }
                >
                  {tr("复制密钥")}
                </button>
                <button onClick={close}>{tr("已保存，关闭")}</button>
              </div>
            </>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setMessage("");
                const fields = new FormData(e.currentTarget);
                try {
                  const result = await host.request<any>(api, {
                    method: "POST",
                    body: JSON.stringify({
                      name: fields.get("name"),
                      channelId: fields.get("channelId") || null,
                      credentialId: fields.get("credentialId") || null,
                      models: String(fields.get("models") ?? "")
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                      requestsPerMinute: Number(fields.get("rpm") || 0),
                      expiresAt: fields.get("expires")
                        ? new Date(String(fields.get("expires"))).getTime()
                        : null,
                    }),
                  });
                  setToken(result.token);
                  keys.reload();
                } catch (error) {
                  setMessage((error as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                {tr("密钥名称")}
                <input
                  name="name"
                  required
                  maxLength={128}
                  autoFocus
                  placeholder={tr("例如：开发环境")}
                  disabled={busy}
                />
              </label>
              <ChannelBinding host={host} initialChannel={initialChannel} />
              <details className="advanced-options">
                <summary>{tr("访问限制（可选）")}</summary>
                <label>
                  {tr("允许的模型 ID")}
                  <input
                    name="models"
                    placeholder={tr("留空允许全部，多个用逗号分隔")}
                    disabled={busy}
                  />
                </label>
                <label>
                  {tr("每分钟请求数")}
                  <input
                    name="rpm"
                    type="number"
                    min="0"
                    max="100000"
                    step="1"
                    placeholder={tr("0 表示不限")}
                    disabled={busy}
                  />
                </label>
                <label>
                  {tr("到期时间")}
                  <input name="expires" type="datetime-local" disabled={busy} />
                </label>
              </details>
              <div className="form-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={close}
                  disabled={busy}
                >
                  {tr("取消")}
                </button>
                <button disabled={busy}>
                  {busy ? tr("创建中…") : tr("创建密钥")}
                </button>
              </div>
            </form>
          )}
        </Dialog>
      )}
      {revoke && (
        <Dialog
          title={tr("撤销 API 密钥")}
          close={() => {
            if (!busy) setRevoke(undefined);
          }}
        >
          <Notice message={message} />
          <p>
            {tr(
              "确定撤销「{0} 」？使用此密钥的应用将无法继续调用，需要更换密钥。",
              { "0": textValue(revoke.name) },
            )}
          </p>
          <div className="form-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setRevoke(undefined)}
            >
              {tr("保留密钥")}
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await host.request(
                    api + "?id=" + encodeURIComponent(revoke.id),
                    { method: "DELETE" },
                  );
                  setRevoke(undefined);
                  setMessage(tr("密钥已撤销。"));
                  keys.reload();
                } catch (error) {
                  setMessage((error as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? tr("撤销中…") : tr("确认撤销")}
            </button>
          </div>
        </Dialog>
      )}
      {binding && (
        <Dialog
          title={tr("修改渠道绑定")}
          close={() => {
            if (!busy) setBinding(undefined);
          }}
        >
          <Notice message={message} />
          <p>
            {tr(
              "修改「{0} 」的渠道，保存后立即用于新请求，完整密钥保持有效。",
              { "0": textValue(binding.name) },
            )}
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              setBusy(true);
              try {
                await host.request(api + "/binding", {
                  method: "PUT",
                  body: JSON.stringify({
                    id: binding.id,
                    channelId: f.get("channelId") || null,
                    credentialId: f.get("credentialId") || null,
                  }),
                });
                setBinding(undefined);
                keys.reload();
                setMessage(tr("渠道绑定已更新。"));
              } catch (error) {
                setMessage((error as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <ChannelBinding
              host={host}
              initialChannel={binding.channel_id ?? ""}
              initialCredential={binding.credential_id ?? ""}
            />
            <div className="form-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setBinding(undefined)}
              >
                {tr("取消")}
              </button>
              <button disabled={busy}>
                {busy ? tr("保存中…") : tr("保存绑定")}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
}
