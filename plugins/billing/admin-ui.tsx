import { t as tr } from "../../lib/ui/i18n.js";
import type { UIHost } from "@pluhub/ui-sdk";
import { AdminTable, adminTime } from "../../lib/ui/admin.js";
import { PriceReceiptView } from "../../lib/ui/price-receipt.js";
export function BillingAdmin({
  host,
  version,
}: {
  host: UIHost;
  version: number;
}) {
  const money = (n: number) => "$" + (n / 1e6).toFixed(6);
  return (
    <>
      <AdminTable
        embedded
        host={host}
        title={tr("全站资金账本")}
        endpoint="/api/plugins/official.billing/admin/ledger"
        version={version}
        columns={[
          { title: tr("时间"), render: (r) => adminTime(r.created_at) },
          {
            title: tr("来源"),
            render: (r) => (
              <>
                <code>{r.source}</code>
                <PriceReceiptView value={r.receipt} />
              </>
            ),
          },
          {
            title: tr("变动（USD）"),
            render: (r) => (
              <span className={r.amount >= 0 ? "positive" : "negative"}>
                {r.amount > 0 ? "+" : ""}
                {money(r.amount)}
              </span>
            ),
          },
          {
            title: tr("调整记录"),
            render: (r) => (
              <>
                {r.actor ?? tr("系统结算")}
                <small>{r.reason ?? ""}</small>
              </>
            ),
          },
        ]}
      />
    </>
  );
}
