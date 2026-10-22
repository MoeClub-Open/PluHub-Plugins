import { t as tr, textValue, getLocale } from "../../lib/ui/i18n.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import {
  AdminTable,
  AdminConfirm,
  AdminIdentity,
  adminTime,
} from "../../lib/ui/admin.js";
const api = "/api/plugins/official.commerce";
const labels: Record<string, string> = {
  get pending() {
    return tr("待支付");
  },
  get paid() {
    return tr("已支付");
  },
  get failed() {
    return tr("支付失败");
  },
  get active() {
    return tr("生效中");
  },
  get past_due() {
    return tr("续费逾期");
  },
  get cancel_at_period_end() {
    return tr("本期结束后不再续订");
  },
  get cancelled() {
    return tr("已取消续订");
  },
};
export function CommerceAdmin({
  host,
  view,
}: {
  host: UIHost;
  view: "orders" | "subscriptions" | "outbox";
}) {
  const [target, setTarget] = React.useState<any>(),
    [retry, setRetry] = React.useState(false),
    [version, setVersion] = React.useState(0);
  const currency = (p: any) =>
    new Intl.NumberFormat(getLocale(), {
      style: "currency",
      currency: p.currency.toUpperCase(),
    }).format(p.paymentMinor / 100);
  return (
    <>
      <AdminTable
        host={host}
        title={
          view === "orders"
            ? tr("全站订单")
            : view === "subscriptions"
              ? tr("全站订阅")
              : tr("支付入账处理")
        }
        endpoint={api + "/admin/" + view}
        version={version}
        statuses={
          view === "orders"
            ? {
                pending: tr("待支付"),
                paid: tr("已支付"),
                failed: tr("支付失败"),
              }
            : view === "subscriptions"
              ? {
                  active: tr("生效中"),
                  past_due: tr("续费逾期"),
                  cancel_at_period_end: tr("已安排停止续订"),
                  cancelled: tr("已取消"),
                }
              : { pending: tr("待入账"), delivered: tr("已入账") }
        }
        columns={
          view === "outbox"
            ? [
                { title: tr("来源"), render: (r) => <code>{r.source}</code> },
                {
                  title: tr("额度 (USD)"),
                  render: (r) => "$" + (r.amount / 1e6).toFixed(6),
                },
                {
                  title: tr("已冲减 (USD)"),
                  render: (r) => "$" + (r.debit / 1e6).toFixed(6),
                },
                {
                  title: tr("支付冻结 (USD)"),
                  render: (r) => "$" + (r.hold / 1e6).toFixed(6),
                },
                {
                  title: tr("入账状态"),
                  render: (r) => (r.delivered ? tr("已入账") : tr("待入账")),
                },
              ]
            : [
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
                      {r.provider}
                      <small>{currency(r.product)}</small>
                    </>
                  ),
                },
                {
                  title: tr("状态"),
                  render: (r) => labels[r.status] ?? r.status,
                },
                {
                  title: view === "orders" ? tr("创建时间") : tr("本期结束"),
                  render: (r) =>
                    adminTime(view === "orders" ? r.created_at : r.period_end),
                },
              ]
        }
        actions={
          view === "subscriptions"
            ? (row) =>
                row.provider === "stripe" &&
                ["active", "past_due"].includes(row.status) ? (
                  <button
                    className="ghost danger"
                    onClick={() => setTarget(row)}
                  >
                    {tr("停止续订")}
                  </button>
                ) : (
                  <span className="muted">—</span>
                )
            : undefined
        }
      >
        {view === "outbox" && (
          <>
            <AdminIdentity host={host} />
            <button className="secondary" onClick={() => setRetry(true)}>
              {tr("重试待入账任务")}
            </button>
          </>
        )}
      </AdminTable>
      {target && (
        <AdminConfirm
          title={tr("停止用户订阅续订")}
          description={tr(
            "为用户停止「{0}」的后续自动扣款，本期权益保留至 {1}。",
            {
              "0": textValue(target.product.name),
              "1": textValue(adminTime(target.period_end)),
            },
          )}
          close={() => setTarget(undefined)}
          submit={async (reason) => {
            await host.request(api + "/admin/subscriptions/cancel", {
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
      {retry && (
        <AdminConfirm
          title={tr("重试待入账任务")}
          description={tr(
            "按已验证的支付、退款与争议记录同步钱包，重复任务不会重复入账或扣款。",
          )}
          close={() => setRetry(false)}
          submit={async (reason) => {
            await host.request(api + "/retry", {
              method: "POST",
              body: JSON.stringify({ reason }),
            });
            setVersion((v) => v + 1);
          }}
        />
      )}
    </>
  );
}
