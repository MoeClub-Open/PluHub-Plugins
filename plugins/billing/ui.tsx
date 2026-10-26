import { t as tr, textValue, getLocale } from "../../lib/ui/i18n.js";
import { billingNote } from "../../lib/ui/billing-note.js";
import { Select } from "../../lib/ui/select.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { mountPage, useLoad, Notice } from "../../lib/ui/mount.js";
import { PageHeading, Stat } from "../../lib/ui/components.js";
import { usdToMicros } from "../../lib/commerce/decimal.js";
import { BillingAdmin } from "./admin-ui.js";
import { OutputBudgetSettings } from "./budget-ui.js";
import { BillingHistory } from "./history-ui.js";
const api = "/api/plugins/official.billing";
const usd = (n: number) =>
  new Intl.NumberFormat(getLocale(), {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 6,
  }).format(n / 1000000);
function Page({ host }: { host: UIHost }) {
  const settings = host.page === "/settings/billing";
  const wallet = useLoad<any>(() => host.request(api + "/wallet"));
  const me = useLoad<any>(() => host.request("/api/plugins/official.auth/me"));
  const reviews = useLoad<any[]>(
    () =>
      settings && me.data?.role === "admin"
        ? host.request(api + "/review")
        : Promise.resolve([]),
    [me.data?.role],
  );
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [adminVersion, setAdminVersion] = React.useState(0);
  async function enableBilling() {
    setBusy(true);
    try {
      const config = await host.request<any>("/api/host/config");
      const plugin = config.plugins.find((p: any) =>
        /\/(?:official\.)?billing$/.test(p.path.replaceAll("\\", "/")),
      );
      plugin.config = { ...plugin.config, enabled: !wallet.data.enabled };
      await host.request("/api/host/config", {
        method: "PUT",
        body: JSON.stringify(config),
      });
      wallet.reload();
      setMessage(tr("计费状态已更新"));
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function reconcile(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const f = new FormData(e.currentTarget);
    try {
      await host.request(api + "/reconcile", {
        method: "POST",
        body: JSON.stringify({
          id: f.get("id"),
          amount: usdToMicros(String(f.get("amount"))),
          reason: f.get("reason"),
        }),
      });
      reviews.reload();
      setAdminVersion((v) => v + 1);
      wallet.reload();
      setMessage(tr("已记录核对结果及操作原因"));
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeading title={settings ? tr("计费设置") : tr("用量与账单")}>
        {wallet.data && !wallet.data.enabled && (
          <span className="badge">{tr("余额扣费未启用")}</span>
        )}
      </PageHeading>
      <Notice message={message || wallet.error || reviews.error} />
      {!settings && (
        <>
          <div className="stats">
            <Stat
              note="USD"
              title={tr("钱包余额")}
              value={wallet.data ? usd(wallet.data.balance) : "—"}
              icon="activity"
            />
            <Stat
              note="USD"
              title={tr("冻结与预留")}
              value={wallet.data ? usd(wallet.data.held) : "—"}
              icon="activity"
            />
            <Stat
              note="USD"
              title={tr("可用余额")}
              value={wallet.data ? usd(wallet.data.available) : "—"}
              icon="activity"
            />
          </div>
          {wallet.data?.paymentHeld > 0 && (
            <p className="muted">
              {tr("其中支付冻结 {0}", { "0": usd(wallet.data.paymentHeld) })}
            </p>
          )}
          <BillingHistory host={host} />
        </>
      )}
      {settings && me.data?.role === "admin" && (
        <div className="card">
          <h2>{tr("待核对请求")}</h2>
          <p className="muted">
            {tr(
              "待核账是预留尚未结算，并非已经扣费。核对上游账单后填写实际费用，填 0 释放预留。",
            )}
          </p>
          {reviews.data?.length ? (
            <form onSubmit={reconcile} className="inline-form">
              <label>
                {tr("请求")}
                <Select name="id">
                  {reviews.data.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.id} · {usd(r.amount)} · {billingNote(r.note)}
                    </option>
                  ))}
                </Select>
              </label>
              <label>
                {tr("实际费用（USD）")}
                <input
                  name="amount"
                  type="number"
                  min="0"
                  step="0.000001"
                  required
                />
              </label>
              <label>
                {tr("核对依据")}
                <input name="reason" required maxLength={256} />
              </label>
              <button disabled={busy}>{tr("确认结算")}</button>
            </form>
          ) : (
            <p className="muted">{tr("没有待核对请求。")}</p>
          )}
        </div>
      )}
      {settings && me.data?.role === "admin" && (
        <section className="card">
          <h2>{tr("计费规则")}</h2>

          <div className="actions">
            <span>
              {tr("预付计费：{0}", {
                "0": textValue(
                  wallet.data?.enabled ? tr("已启用") : tr("未启用"),
                ),
              })}
            </span>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void enableBilling()}
            >
              {wallet.data?.enabled ? tr("停用预付计费") : tr("启用预付计费")}
            </button>
          </div>
        </section>
      )}
      {settings && me.data?.role === "admin" && (
        <OutputBudgetSettings host={host} />
      )}
      {settings && me.data?.role === "admin" && (
        <BillingAdmin host={host} version={adminVersion} />
      )}
    </>
  );
}
export const mount = (el: HTMLElement, host: UIHost) =>
  mountPage(el, host, Page);
