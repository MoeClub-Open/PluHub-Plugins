import { t as tr, textValue } from "../../lib/ui/i18n.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { AdminTable, AdminConfirm, adminTime } from "../../lib/ui/admin.js";
export function KeyAdmin({ host }: { host: UIHost }) {
  const [target, setTarget] = React.useState<any>(),
    [version, setVersion] = React.useState(0);
  return (
    <>
      <AdminTable
        host={host}
        title={tr("访问密钥管理")}
        endpoint="/api/plugins/official.auth/admin/keys"
        version={version}
        statuses={{ active: tr("有效"), expired: tr("已过期") }}
        columns={[
          {
            title: tr("名称 / 前缀"),
            render: (r) => (
              <>
                <strong>{r.name}</strong>
                <small>
                  <code>{r.prefix}…</code>
                </small>
              </>
            ),
          },
          {
            title: tr("模型 / 渠道"),
            render: (r) => (
              <>
                {r.models.length ? r.models.join(", ") : tr("全部模型")}
                <small>
                  {r.channelIds?.length
                    ? r.channelIds.join(", ")
                    : (r.channel_id ?? tr("平台默认路由"))}
                </small>
              </>
            ),
          },
          {
            title: tr("频率 / 到期"),
            render: (r) => (
              <>
                {r.requests_per_minute
                  ? r.requests_per_minute + tr(" 次/分钟")
                  : tr("不限频率")}
                <small>
                  {r.expires_at ? adminTime(r.expires_at) : tr("长期有效")}
                </small>
              </>
            ),
          },
          { title: tr("最近使用"), render: (r) => adminTime(r.last_used_at) },
        ]}
        actions={(row) => (
          <button className="ghost danger" onClick={() => setTarget(row)}>
            {tr("撤销密钥")}
          </button>
        )}
      />
      {target && (
        <AdminConfirm
          title={tr("撤销用户密钥")}
          description={tr("撤销「{0}」后，使用此 Key 的应用将无法继续调用。", {
            "0": textValue(target.name),
          })}
          close={() => setTarget(undefined)}
          submit={async (reason) => {
            await host.request("/api/plugins/official.auth/admin/keys/revoke", {
              method: "POST",
              body: JSON.stringify({
                id: target.id,
                userId: target.user_id,
                reason,
              }),
            });
            setVersion((v) => v + 1);
          }}
        />
      )}
    </>
  );
}
