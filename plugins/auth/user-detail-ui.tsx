import { t as tr, textValue, getLocale } from "../../lib/ui/i18n.js";
import { Select } from "../../lib/ui/select.js";
import React from "react";
import type { UIHost, Extension } from "@pluhub/ui-sdk";
import { useLoad, Notice } from "../../lib/ui/mount.js";
import { Dialog } from "../../lib/ui/components.js";
import { AdminTable, AdminConfirm, adminTime } from "../../lib/ui/admin.js";
import { paymentLabels } from "../../lib/commerce/checkout.js";
import { UserBalance } from "./user-balance-ui.js";
import { KeyAdmin } from "./admin-ui.js";

const orderStates: Record<string, string> = {
  get pending() {
    return tr("待支付");
  },
  get paid() {
    return tr("已支付");
  },
  get failed() {
    return tr("支付失败");
  },
};

export function UserDetail({
  host,
  user,
  close,
  updated,
  self,
}: {
  host: UIHost;
  user: any;
  close: () => void;
  updated: () => void;
  self: boolean;
}) {
  const details = useLoad<any>(() =>
    host.request(
      "/api/plugins/official.auth/admin/user?userId=" +
        encodeURIComponent(user.id),
    ),
  );
  const [action, setAction] = React.useState("");
  const [tab, setTab] = React.useState("account");
  const [channelTarget, setChannelTarget] = React.useState<any>();
  const [channelVersion, setChannelVersion] = React.useState(0);
  const members = useLoad<any[]>(() =>
    host.request("/api/plugins/official.auth/users"),
  );
  const [memberType, setMemberType] = React.useState(
    user.accountType ?? "personal",
  );
  const [parentId, setParentId] = React.useState(user.parentId ?? "");
  const extensions = useLoad<Extension[]>(() =>
    host.request("/api/host/extensions"),
  );
  const hasExtension = (path: string) =>
    !!extensions.data?.some((entry) => entry.path === path);
  const billingAvailable = hasExtension("/settings/billing");
  const byokAvailable = hasExtension("/settings/user-channels");
  const commerceAvailable = hasExtension("/settings/commerce");
  const d = details.data;
  const administrator = (d?.role ?? user.role) === "admin";
  const link = (path: string) =>
    "#" + path + "?userId=" + encodeURIComponent(user.id);
  const currency = (p: any) =>
    new Intl.NumberFormat(getLocale(), {
      style: "currency",
      currency: p.currency.toUpperCase(),
    }).format(p.paymentMinor / 100);

  if (channelTarget)
    return (
      <AdminConfirm
        title={
          channelTarget.blocked ? tr("解除渠道封禁") : tr("封禁用户渠道")
        }
        description={
          channelTarget.blocked
            ? tr("解除「{0}」的管理员封禁，仍保留用户原来的启停状态。", {
                "0": textValue(channelTarget.name),
              })
            : tr(
                "封禁「{0}」后立即拒绝新请求，用户无法通过启用或修改设置绕过。",
                { "0": textValue(channelTarget.name) },
              )
        }
        close={() => setChannelTarget(undefined)}
        submit={async (reason) => {
          await host.request(
            "/api/plugins/official.byok/admin/channels/block",
            {
              method: "POST",
              body: JSON.stringify({
                id: channelTarget.id,
                userId: channelTarget.user_id,
                blocked: !channelTarget.blocked,
                reason,
              }),
            },
          );
          setChannelVersion((v) => v + 1);
        }}
      />
    );

  if (action)
    return (
      <AdminConfirm
        requestReason={false}
        title={
          action === "membership"
            ? tr("账号归属")
            : action === "password"
              ? tr("重置用户密码")
              : action === "admin"
                ? administrator
                  ? tr("取消管理员权限")
                  : tr("设为管理员")
                : action === "factors"
                  ? tr("重置验证方式")
                  : tr("撤销全部会话")
        }
        description={
          action === "membership"
            ? tr("企业主账号可查看直属子账号的请求记录。")
            : action === "password"
              ? tr("设置新密码并撤销此用户全部控制台会话，API Key 保持不变。")
              : action === "admin"
                ? tr(
                    administrator
                      ? "确认取消「{0}」的管理员权限？"
                      : "确认将「{0}」设为管理员？",
                    { "0": textValue(user.username) },
                  )
                : action === "factors"
                  ? tr(
                      "移除用户的 TOTP、恢复码、Passkey 和全部会话。邮箱绑定和密码保留。",
                    )
                  : tr("使该用户所有控制台会话失效，API Key 保持不变。")
        }
        close={() => setAction("")}
        submit={async (_reason, fields) => {
          const endpoint =
            action === "password"
              ? "/api/plugins/official.auth/password"
              : action === "admin" || action === "membership"
                ? "/api/plugins/official.auth/users"
                : action === "factors"
                  ? "/api/plugins/official.auth/admin/factors/reset"
                  : "/api/plugins/official.auth/admin/sessions/revoke";
          const payload =
            action === "admin" || action === "membership"
              ? {
                  id: user.id,
                  ...(action === "membership"
                    ? { accountType: memberType, parentId: parentId || null }
                    : { role: administrator ? "user" : "admin" }),
                }
              : {
                  userId: user.id,
                  ...(action === "password"
                    ? { password: fields.get("password") }
                    : action === "factors"
                      ? { confirmUsername: fields.get("confirmUsername") }
                      : {}),
                };
          await host.request(endpoint, {
            method:
              action === "admin" || action === "membership" ? "PATCH" : "POST",
            body: JSON.stringify(payload),
          });
          details.reload();
          updated();
        }}
      >
        {action === "membership" && (
          <>
            <Notice message={members.error} />
            <label>
              {tr("账号类型")}
              <Select
                value={memberType}
                onChange={(e) => {
                  setMemberType(e.target.value);
                  if (e.target.value === "enterprise") setParentId("");
                }}
              >
                <option value="personal">{tr("个人账号")}</option>
                <option value="enterprise">{tr("企业主账号")}</option>
              </Select>
            </label>
            {memberType === "personal" && (
              <label>
                {tr("所属企业")}
                <Select
                  value={parentId}
                  onChange={(e) => setParentId(e.target.value)}
                >
                  <option value="">{tr("独立账号")}</option>
                  {members.data
                    ?.filter(
                      (member) =>
                        member.id !== user.id &&
                        member.accountType === "enterprise" &&
                        member.enabled,
                    )
                    .map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.username}
                      </option>
                    ))}
                </Select>
              </label>
            )}
          </>
        )}
        {action === "password" && (
          <label>
            {tr("新密码")}
            <input
              name="password"
              type="password"
              required
              minLength={12}
              maxLength={1024}
              autoComplete="new-password"
            />
          </label>
        )}
        {action === "factors" && (
          <label>
            {tr("输入用户名")}
            {user.username} {tr("确认")}
            <input name="confirmUsername" required autoComplete="off" />
          </label>
        )}
      </AdminConfirm>
    );

  const tabs = [
    ["account", tr("概览与安全")],
    ...(billingAvailable ? [["balance", tr("余额与账本")]] : []),
    ["keys", tr("API 密钥")],
    ...(byokAvailable ? [["channels", tr("个人渠道")]] : []),
    ...(commerceAvailable ? [["orders", tr("订单记录")]] : []),
  ];

  return (
    <Dialog title={user.username + tr(" · 用户详情")} close={close}>
      <style>{`.modal:has(.user-detail-tabs){width:min(920px,calc(100vw - 32px));max-width:920px}`}</style>
      <Notice message={details.error || extensions.error} />
      <p>
        <code>{user.id}</code> ·{" "}
        {(d?.role ?? user.role) === "admin" ? tr("管理员") : tr("非管理员")} ·{" "}
        {(d?.enabled ?? user.enabled) ? tr("启用") : tr("禁用")}
      </p>
      <div
        className="compact-tabs user-detail-tabs"
        role="tablist"
        aria-label={tr("用户详情")}
      >
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id!)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "balance" && billingAvailable ? (
        <UserBalance key={user.id} host={host} user={user} />
      ) : tab === "keys" ? (
        <KeyAdmin host={host} fixedUserId={user.id} />
      ) : tab === "channels" && byokAvailable ? (
        <AdminTable
          host={host}
          embedded
          fixedUserId={user.id}
          title={tr("个人渠道")}
          endpoint="/api/plugins/official.byok/admin/channels"
          version={channelVersion}
          statuses={{
            enabled: tr("用户启用"),
            disabled: tr("用户停用"),
            blocked: tr("管理员封禁"),
          }}
          columns={[
            {
              title: tr("渠道 / 地址"),
              render: (r) => (
                <>
                  <strong>{r.name}</strong>
                  <small>{r.baseUrl}</small>
                </>
              ),
            },
            {
              title: tr("协议 / 模型"),
              render: (r) => (
                <>
                  {r.protocol}
                  <small>
                    {tr("{0} 个模型", {
                      "0": textValue(Object.keys(r.models).length),
                    })}
                  </small>
                </>
              ),
            },
            {
              title: tr("状态"),
              render: (r) => (
                <>
                  <span
                    className={
                      "badge " + (!r.blocked && r.enabled ? "ready" : "")
                    }
                  >
                    {r.blocked
                      ? tr("管理员封禁")
                      : r.enabled
                        ? tr("用户启用")
                        : tr("用户停用")}
                  </span>
                  {r.blocked && <small>{r.blockReason}</small>}
                </>
              ),
            },
          ]}
          actions={(row) => (
            <button
              className={"ghost " + (row.blocked ? "" : "danger")}
              onClick={() => setChannelTarget(row)}
            >
              {row.blocked ? tr("解除封禁") : tr("封禁渠道")}
            </button>
          )}
        />
      ) : tab === "orders" && commerceAvailable ? (
        <AdminTable
          host={host}
          embedded
          fixedUserId={user.id}
          title={tr("订单记录")}
          endpoint="/api/plugins/official.commerce/admin/orders"
          statuses={{
            pending: tr("待支付"),
            paid: tr("已支付"),
            failed: tr("支付失败"),
          }}
          columns={[
            {
              title: tr("记录 / 商品"),
              render: (r) => (
                <>
                  <code>{r.id}</code>
                  <small>{r.product.name}</small>
                </>
              ),
            },
            {
              title: tr("支付方式 / 金额"),
              render: (r) => (
                <>
                  {tr(
                    paymentLabels[r.payment_method_name ?? r.provider] ??
                      r.payment_method_name ??
                      r.provider,
                  )}
                  <small>{currency(r.product)}</small>
                </>
              ),
            },
            {
              title: tr("状态"),
              render: (r) => orderStates[r.status] ?? r.status,
            },
            {
              title: tr("创建时间"),
              render: (r) => adminTime(r.created_at),
            },
          ]}
        />
      ) : (
        <>
          <div className="card">
            <p>
              {tr("验证邮箱：{0}", { "0": textValue(d?.email ?? "未绑定") })}
            </p>
            <p>
              {tr("密码：{0} · TOTP： {1} · Passkey： {2} 个", {
                "0": textValue(d?.passwordSet ? tr("已设置") : tr("未设置")),
                "1": textValue(d?.totpEnabled ? tr("已启用") : tr("未启用")),
                "2": textValue(d?.passkeyCount ?? 0),
              })}
            </p>
            <p>
              {tr("有效会话：{0} · Key：{1} 个（ {2} 个有效）", {
                "0": textValue(d?.sessions ?? 0),
                "1": textValue(d?.keys ?? 0),
                "2": textValue(d?.activeKeys ?? 0),
              })}
            </p>
          </div>
          <div className="actions">
            <button
              className="secondary"
              disabled={!d}
              onClick={() => {
                setMemberType(d.accountType);
                setParentId(d.parentId ?? "");
                setAction("membership");
              }}
            >
              {tr("账号归属")}
            </button>
            <a className="button secondary" href={link("/audit")}>
              {tr("操作记录")}
            </a>
          </div>
          <hr />
          <div className="actions">
            <button
              className="secondary"
              disabled={self || !d}
              onClick={() => setAction("admin")}
            >
              {administrator ? tr("取消管理员权限") : tr("设为管理员")}
            </button>
            <button
              className="secondary"
              disabled={self || !d}
              onClick={() => setAction("password")}
            >
              {tr("重置密码")}
            </button>
            <button
              className="secondary"
              disabled={self || !d}
              onClick={() => setAction("sessions")}
            >
              {tr("撤销会话")}
            </button>
            <button
              className="ghost danger"
              disabled={self || !d}
              onClick={() => setAction("factors")}
            >
              {tr("重置验证方式")}
            </button>
          </div>
          {self && (
            <p className="field-note">
              {tr("当前账号的安全设置请从「账号设置」管理。")}
            </p>
          )}
        </>
      )}
    </Dialog>
  );
}
