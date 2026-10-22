import { t as tr, textValue } from "../../lib/ui/i18n.js";
import { Select } from "../../lib/ui/select.js";
import React from "react";
import type { UIHost, Extension } from "@pluhub/ui-sdk";
import { useLoad, Notice } from "../../lib/ui/mount.js";
import { Dialog } from "../../lib/ui/components.js";
import { AdminConfirm } from "../../lib/ui/admin.js";
import { UserBalance } from "./balance-ui.js";
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
  const members = useLoad<any[]>(() =>
    host.request("/api/plugins/official.users/users"),
  );
  const [memberType, setMemberType] = React.useState(
    user.accountType ?? "personal",
  );
  const [parentId, setParentId] = React.useState(user.parentId ?? "");
  const extensions = useLoad<Extension[]>(() =>
    host.request("/api/host/extensions"),
  );
  const billingAvailable = extensions.data?.some(
    (entry) => entry.path === "/settings/billing",
  );
  const d = details.data;
  const administrator = (d?.role ?? user.role) === "admin";
  const link = (path: string) =>
    "#" + path + "?userId=" + encodeURIComponent(user.id);
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
                ? "/api/plugins/official.users/users"
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
  return (
    <Dialog title={user.username + tr(" · 用户详情")} close={close}>
      <Notice message={details.error || extensions.error} />
      <p>
        <code>{user.id}</code> ·{" "}
        {(d?.role ?? user.role) === "admin" ? tr("管理员") : tr("非管理员")} ·{" "}
        {(d?.enabled ?? user.enabled) ? tr("启用") : tr("禁用")}
      </p>
      {billingAvailable && (
        <div
          className="compact-tabs"
          role="tablist"
          aria-label={tr("用户详情")}
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === "account"}
            className={tab === "account" ? "active" : ""}
            onClick={() => setTab("account")}
          >
            {tr("账号与权限")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "balance"}
            className={tab === "balance" ? "active" : ""}
            onClick={() => setTab("balance")}
          >
            {tr("余额与账本")}
          </button>
        </div>
      )}
      {tab === "balance" && billingAvailable ? (
        <UserBalance key={user.id} host={host} user={user} />
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
            <a
              className="button secondary"
              href={link("/settings/access-keys")}
            >
              {tr("查看密钥")}
            </a>
            <a
              className="button secondary"
              href={link("/settings/user-channels")}
            >
              {tr("查看渠道")}
            </a>
            <a className="button secondary" href={link("/settings/commerce")}>
              {tr("订单与订阅")}
            </a>
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
