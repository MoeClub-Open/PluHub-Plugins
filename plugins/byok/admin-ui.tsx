import { t as tr, textValue } from "../../lib/ui/i18n.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { AdminTable, AdminConfirm } from "../../lib/ui/admin.js";
export function ChannelAdmin({ host }: { host: UIHost }) {
  const [target, setTarget] = React.useState<any>(),
    [version, setVersion] = React.useState(0);
  return (
    <>
      <AdminTable
        host={host}
        title={tr("用户渠道管理")}
        endpoint="/api/plugins/official.byok/admin/channels"
        version={version}
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
                <small>
                  <code>{r.id}</code>
                </small>
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
            onClick={() => setTarget(row)}
          >
            {row.blocked ? tr("解除封禁") : tr("封禁渠道")}
          </button>
        )}
      />
      {target && (
        <AdminConfirm
          title={target.blocked ? tr("解除渠道封禁") : tr("封禁用户渠道")}
          description={
            target.blocked
              ? tr("解除「{0}」的管理员封禁，仍保留用户原来的启停状态。", {
                  "0": textValue(target.name),
                })
              : tr(
                  "封禁「{0}」后立即拒绝新请求，用户无法通过启用或修改设置绕过。",
                  { "0": textValue(target.name) },
                )
          }
          close={() => setTarget(undefined)}
          submit={async (reason) => {
            await host.request(
              "/api/plugins/official.byok/admin/channels/block",
              {
                method: "POST",
                body: JSON.stringify({
                  id: target.id,
                  userId: target.user_id,
                  blocked: !target.blocked,
                  reason,
                }),
              },
            );
            setVersion((v) => v + 1);
          }}
        />
      )}
    </>
  );
}
