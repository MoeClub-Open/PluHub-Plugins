import { t as tr, textValue, getLocale } from "../../lib/ui/i18n.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { mountPage, useLoad, Notice } from "../../lib/ui/mount.js";
import { PageHeading, Stat } from "../../lib/ui/components.js";
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
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
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
  return (
    <>
      <PageHeading title={settings ? tr("计费设置") : tr("用量与账单")}>
        {wallet.data && !wallet.data.enabled && (
          <span className="badge">{tr("余额扣费未启用")}</span>
        )}
      </PageHeading>
      <Notice message={message || wallet.error} />
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
      {settings && me.data?.role === "admin" && <BillingAdmin host={host} />}
    </>
  );
}
export const mount = (el: HTMLElement, host: UIHost) =>
  mountPage(el, host, Page);
