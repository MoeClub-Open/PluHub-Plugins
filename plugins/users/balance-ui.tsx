import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { t as tr, textValue, getLocale } from "../../lib/ui/i18n.js";
import { useLoad, Notice } from "../../lib/ui/mount.js";
import { Dialog, Icon, ListPagination } from "../../lib/ui/components.js";
import { usdToMicros } from "../../lib/commerce/decimal.js";
import { PriceReceiptView } from "../../lib/ui/price-receipt.js";

const api = "/api/plugins/official.billing";
const usd = (value: number) =>
  new Intl.NumberFormat(getLocale(), {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 6,
  }).format(value / 1e6);
type Wallet = { balance: number; held: number; available: number };
type Ledger = {
  total: number;
  items: {
    id: number;
    amount: number;
    source: string;
    created_at: number;
    actor?: string;
    reason?: string;
    receipt?: string;
  }[];
};

export function UserBalance({
  host,
  user,
}: {
  host: UIHost;
  user: { id: string; username: string };
}) {
  const [page, setPage] = React.useState(1);
  const [size, setSize] = React.useState(10);
  const [query, setQuery] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [pending, setPending] = React.useState<{
    amount: number;
    reason: string;
  }>();
  const id = React.useRef(crypto.randomUUID());
  const form = React.useRef<HTMLFormElement>(null);
  const wallet = useLoad<Wallet>(
    () =>
      host.request(api + "/admin/wallet?userId=" + encodeURIComponent(user.id)),
    [user.id],
  );
  const ledger = useLoad<Ledger>(
    () =>
      host.request(
        api +
          "/admin/ledger?" +
          new URLSearchParams({
            userId: user.id,
            q: query,
            limit: String(size),
            offset: String((page - 1) * size),
          }),
      ),
    [user.id, page, size, query],
  );
  React.useEffect(() => {
    if (ledger.data)
      setPage((current) =>
        Math.min(current, Math.max(1, Math.ceil(ledger.data!.total / size))),
      );
  }, [ledger.data, size]);
  const refresh = () => {
    wallet.reload();
    ledger.reload();
  };
  async function confirm() {
    if (!pending) return;
    setBusy(true);
    setMessage("");
    try {
      await host.request(api + "/adjust", {
        method: "POST",
        body: JSON.stringify({
          id: id.current,
          userId: user.id,
          amount: pending.amount,
          reason: pending.reason,
        }),
      });
      id.current = crypto.randomUUID();
      form.current?.reset();
      setPending(undefined);
      refresh();
      setMessage(tr("审计调整已入账"));
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {!pending && <Notice message={message || wallet.error || ledger.error} />}
      <div className="section-heading">
        <h2>{tr("用户余额")}</h2>
        <button
          type="button"
          className="secondary icon-button"
          aria-label={tr("刷新余额与账本")}
          title={tr("刷新余额与账本")}
          onClick={refresh}
        >
          <Icon name="refresh" size={15} />
        </button>
      </div>
      <div className="account-profile card">
        {(
          [
            [tr("钱包余额"), wallet.data?.balance],
            [tr("冻结与预留"), wallet.data?.held],
            [tr("可用余额"), wallet.data?.available],
          ] as const
        ).map(([title, value]) => (
          <div key={title}>
            <small>{title}</small>
            <strong>{value === undefined ? "—" : usd(value)}</strong>
          </div>
        ))}
      </div>
      <form
        ref={form}
        className="card"
        onSubmit={(event) => {
          event.preventDefault();
          const fields = new FormData(event.currentTarget);
          try {
            const amount = usdToMicros(String(fields.get("amount")));
            if (!amount) throw new Error(tr("调整金额不能为 0"));
            setMessage("");
            setPending({ amount, reason: String(fields.get("reason")).trim() });
          } catch (error) {
            setMessage((error as Error).message);
          }
        }}
      >
        <h2>{tr("调整余额")}</h2>
        <div className="form-grid">
          <label>
            {tr("调整金额（USD，负数扣除）")}
            <input type="number" name="amount" step="0.000001" required />
          </label>
          <label>
            {tr("审计原因")}
            <input name="reason" required maxLength={256} pattern=".*\S.*" />
          </label>
        </div>
        <button disabled={busy || !wallet.data}>{tr("记录调整")}</button>
      </form>
      <div className="section-heading">
        <h2>{tr("资金明细")}</h2>
        <input
          type="search"
          aria-label={tr("搜索用户账本")}
          placeholder={tr("搜索来源 / 请求 ID")}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(1);
          }}
        />
      </div>
      <div className="table-wrap">
        <table
          style={{ tableLayout: "fixed", whiteSpace: "normal", minWidth: 560 }}
        >
          <thead>
            <tr>
              <th style={{ width: "25%" }}>{tr("时间")}</th>
              <th style={{ width: "20%" }}>{tr("变动（USD）")}</th>
              <th style={{ width: "20%" }}>{tr("来源")}</th>
              <th>{tr("调整记录")}</th>
            </tr>
          </thead>
          <tbody>
            {ledger.data?.items.map((row) => (
              <tr key={row.id}>
                <td>{new Date(row.created_at).toLocaleString(getLocale())}</td>
                <td className={row.amount >= 0 ? "positive" : "negative"}>
                  {row.amount > 0 ? "+" : ""}
                  {usd(row.amount)}
                </td>
                <td style={{ overflowWrap: "anywhere" }}>
                  <code title={row.source}>
                    {row.source.length > 24
                      ? row.source.slice(0, 21) + "…"
                      : row.source}
                  </code>
                  <PriceReceiptView value={row.receipt} />
                </td>
                <td style={{ overflowWrap: "anywhere" }}>
                  <span title={row.actor}>
                    {row.actor ? row.actor.slice(0, 8) + "…" : tr("系统结算")}
                  </span>
                  <small>{row.reason}</small>
                </td>
              </tr>
            ))}
            {!ledger.data?.items.length && (
              <tr>
                <td colSpan={4} className="empty-inline">
                  {ledger.data
                    ? tr("还没有资金变动")
                    : ledger.error
                      ? tr("加载失败，请刷新重试。")
                      : tr("正在加载…")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <ListPagination
        total={ledger.data?.total ?? 0}
        page={page}
        size={size}
        setPage={setPage}
        setSize={(value) => {
          setSize(value);
          setPage(1);
        }}
      />
      {pending && (
        <Dialog
          title={tr("确认余额调整")}
          close={() => {
            if (!busy) setPending(undefined);
          }}
        >
          <Notice message={message} />
          <p>
            {tr("用户：")}
            <strong>{user.username}</strong>
          </p>
          <p>
            {pending.amount > 0 ? tr("增加") : tr("扣除")}
            {tr("余额")} <strong>{usd(Math.abs(pending.amount))}</strong>
          </p>
          <p>{tr("原因：{0}", { "0": textValue(pending.reason) })}</p>
          <div className="form-actions">
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setPending(undefined)}
            >
              {tr("取消")}
            </button>
            <button
              type="button"
              className={pending.amount < 0 ? "danger" : ""}
              disabled={busy}
              onClick={() => void confirm()}
            >
              {busy ? tr("处理中…") : tr("确认入账")}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
