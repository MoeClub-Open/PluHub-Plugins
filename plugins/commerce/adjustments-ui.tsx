import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { t as tr, getLocale } from "../../lib/ui/i18n.js";
import { AdminTable, AdminConfirm, adminTime } from "../../lib/ui/admin.js";
import { useLoad, Notice } from "../../lib/ui/mount.js";
import { Dialog } from "../../lib/ui/components.js";
const api = "/api/plugins/official.commerce";
function statusLabel(status: string) {
  const labels: Record<string, string> = {
    pending: tr("退款处理中"),
    succeeded: tr("退款成功"),
    failed: tr("退款失败"),
    cancelled: tr("退款已取消"),
    open: tr("争议处理中"),
    won: tr("争议胜诉"),
    lost: tr("争议败诉"),
    closed: tr("争议已关闭"),
    review: tr("待核对"),
  };
  return labels[status] ?? tr("待核对");
}
const money = (r: any) =>
  new Intl.NumberFormat(getLocale(), {
    style: "currency",
    currency: r.currency.toUpperCase(),
  }).format(r.amount / 100);
function reviewLabel(reason: string) {
  const labels: Record<string, string> = {
    "Payment has not been matched": tr("尚未匹配支付"),
    "Payment reference is ambiguous": tr("支付关联不明确"),
    "Payment did not grant credit": tr("该支付未发放额度"),
    "Payment amount, currency or status requires review":
      tr("金额、币种或状态需核对"),
  };
  return labels[reason] ?? tr("待核对");
}
export function PaymentAdjustmentsAdmin({ host }: { host: UIHost }) {
  const [target, setTarget] = React.useState<any>(),
    [version, setVersion] = React.useState(0);
  return (
    <>
      <AdminTable
        host={host}
        title={tr("退款与争议")}
        endpoint={api + "/admin/adjustments"}
        version={version}
        statuses={Object.fromEntries(
          [
            "review",
            "pending",
            "succeeded",
            "failed",
            "cancelled",
            "open",
            "won",
            "lost",
            "closed",
          ].map((s) => [s, statusLabel(s)]),
        )}
        columns={[
          {
            title: tr("类型 / 记录"),
            render: (r) => (
              <>
                {r.kind === "refund" ? tr("退款") : tr("支付争议")}
                <small>
                  {r.provider} · {r.object_id}
                </small>
              </>
            ),
          },
          { title: tr("金额"), render: money },
          {
            title: tr("状态"),
            render: (r) => (
              <>
                {statusLabel(r.status)}
                {r.review && (
                  <small className="negative">{reviewLabel(r.review)}</small>
                )}
              </>
            ),
          },
          {
            title: tr("订单"),
            render: (r) =>
              r.order_id ? <code>{r.order_id}</code> : tr("待匹配"),
          },
          { title: tr("更新时间"), render: (r) => adminTime(r.updated_at) },
        ]}
        actions={(r) =>
          r.provider === "stripe" ? (
            <button className="ghost" onClick={() => setTarget(r)}>
              {tr("重新核对")}
            </button>
          ) : (
            "—"
          )
        }
      />
      {target && (
        <AdminConfirm
          title={tr("重新核对支付状态")}
          description={tr(
            "读取支付平台的最新退款或争议状态，并同步钱包。此操作不会发起退款或提交争议材料。",
          )}
          close={() => setTarget(undefined)}
          submit={async (reason) => {
            await host.request(api + "/admin/adjustments/recheck", {
              method: "POST",
              body: JSON.stringify({
                id: target.object_id,
                provider: target.provider,
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
export function OrderAdjustments({
  host,
  order,
  close,
}: {
  host: UIHost;
  order: any;
  close: () => void;
}) {
  const data = useLoad<{ items: any[]; total: number }>(() =>
    host.request(
      api +
        "/adjustments?orderId=" +
        encodeURIComponent(order.id) +
        "&limit=100",
    ),
  );
  return (
    <Dialog title={tr("退款与争议")} close={close}>
      <p>{order.product.name}</p>
      <Notice message={data.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{tr("类型")}</th>
              <th>{tr("金额")}</th>
              <th>{tr("状态")}</th>
              <th>{tr("更新时间")}</th>
            </tr>
          </thead>
          <tbody>
            {data.data?.items.map((r) => (
              <tr key={r.provider + ":" + r.object_id}>
                <td>{r.kind === "refund" ? tr("退款") : tr("支付争议")}</td>
                <td>{money(r)}</td>
                <td>{statusLabel(r.status)}</td>
                <td>{adminTime(r.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!data.data?.items.length && (
        <p className="empty-inline">
          {data.data ? tr("暂无记录") : tr("正在加载…")}
        </p>
      )}
      {data.data && data.data.total > data.data.items.length && (
        <p>{tr("共 {0} 条，仅显示最近 100 条。", { "0": data.data.total })}</p>
      )}
    </Dialog>
  );
}
