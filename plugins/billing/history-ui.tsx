import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { t as tr, getLocale } from "../../lib/ui/i18n.js";
import { useLoad, Notice } from "../../lib/ui/mount.js";
import { Select } from "../../lib/ui/select.js";
import { PriceReceiptView } from "../../lib/ui/price-receipt.js";
import { ListPagination, Empty } from "../../lib/ui/components.js";
import { downloadCsv } from "../../lib/ui/download.js";
export function BillingHistory({ host }: { host: UIHost }) {
  const [q, setQ] = React.useState(""),
    [search, setSearch] = React.useState(""),
    [kind, setKind] = React.useState(""),
    [days, setDays] = React.useState(0);
  const [page, setPage] = React.useState(1),
    [size, setSize] = React.useState(20),
    [busy, setBusy] = React.useState(false),
    [message, setMessage] = React.useState("");
  const range = React.useMemo(
    (): Record<string, string> =>
      days
        ? { from: String(Date.now() - days * 86400000), to: String(Date.now()) }
        : {},
    [days],
  );
  const query = new URLSearchParams({
    ...range,
    ...(search ? { q: search } : {}),
    ...(kind ? { kind } : {}),
  });
  const data = useLoad<{ items: any[]; total: number }>(
    () =>
      host.request(
        "/api/plugins/official.billing/ledger/history?" +
          query +
          "&limit=" +
          size +
          "&offset=" +
          (page - 1) * size,
      ),
    [search, kind, days, page, size],
  );
  const money = (amount: number) =>
    new Intl.NumberFormat(getLocale(), {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 6,
    }).format(amount / 1000000);
  return (
    <section>
      <div className="section-heading">
        <h2>{tr("资金明细")}</h2>
        <button
          className="secondary"
          disabled={busy || !data.data?.total}
          onClick={() => {
            setBusy(true);
            setMessage("");
            void downloadCsv(
              "/api/plugins/official.billing/ledger/export?" + query,
              "pluhub-ledger.csv",
            )
              .catch((error) => setMessage(error.message))
              .finally(() => setBusy(false));
          }}
        >
          {tr("导出 CSV")}
        </button>
      </div>
      <Notice message={message || data.error} />
      <form
        className="list-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(q.trim());
          setPage(1);
        }}
      >
        <input
          type="search"
          aria-label={tr("搜索账单")}
          placeholder={tr("搜索来源 / 请求 ID")}
          value={q}
          maxLength={128}
          onChange={(event) => setQ(event.target.value)}
        />
        <Select
          aria-label={tr("账单类型")}
          value={kind}
          onChange={(event) => {
            setKind(event.target.value);
            setPage(1);
          }}
        >
          <option value="">{tr("全部类型")}</option>
          <option value="credit">{tr("入账")}</option>
          <option value="debit">{tr("支出")}</option>
        </Select>
        <Select
          aria-label={tr("账单时间范围")}
          value={days}
          onChange={(event) => {
            setDays(Number(event.target.value));
            setPage(1);
          }}
        >
          <option value="0">{tr("全部时间")}</option>
          <option value="7">{tr("最近 7 天")}</option>
          <option value="30">{tr("最近 30 天")}</option>
        </Select>
        <button className="secondary">{tr("筛选")}</button>
        {!!(search || kind || days) && (
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setQ("");
              setSearch("");
              setKind("");
              setDays(0);
              setPage(1);
            }}
          >
            {tr("重置筛选")}
          </button>
        )}
      </form>
      {data.data?.total === 0 ? (
        <Empty title={tr("没有匹配的资金明细")} />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{tr("时间")}</th>
                <th>{tr("来源")}</th>
                <th>{tr("变动 (USD)")}</th>
              </tr>
            </thead>
            <tbody>
              {data.data?.items.map((row) => (
                <tr key={row.id}>
                  <td>
                    {new Date(row.created_at).toLocaleString(getLocale())}
                  </td>
                  <td>
                    {row.source.startsWith("payment-state:") && (
                      <span>{tr("支付冲减 / 恢复")}</span>
                    )}
                    <code>{row.source}</code>
                    <PriceReceiptView value={row.receipt} />
                  </td>
                  <td className={row.amount >= 0 ? "positive" : "negative"}>
                    {row.amount > 0 ? "+" : ""}
                    {money(row.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!!data.data?.total && (
        <ListPagination
          total={data.data.total}
          page={page}
          size={size}
          setPage={setPage}
          setSize={(value) => {
            setSize(value);
            setPage(1);
          }}
        />
      )}
    </section>
  );
}
