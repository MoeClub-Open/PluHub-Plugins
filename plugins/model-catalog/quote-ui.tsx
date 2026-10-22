import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { t as tr } from "../../lib/ui/i18n.js";
import { Notice } from "../../lib/ui/mount.js";
import { PriceReceiptView } from "../../lib/ui/price-receipt.js";
export function PriceQuote({
  host,
  model,
  requestPriced = false,
}: {
  host: UIHost;
  model: string;
  requestPriced?: boolean;
}) {
  const [receipt, setReceipt] = React.useState<string>();
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  return (
    <details>
      <summary>{tr("费用试算")}</summary>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const fields = new FormData(e.currentTarget);
          setBusy(true);
          setMessage("");
          setReceipt(undefined);
          try {
            const usage = Object.fromEntries(
              [
                "input",
                "output",
                "cacheRead",
                "cacheWrite",
                "cacheWrite1h",
              ].map((key) => [key, Number(fields.get(key) || 0)]),
            );
            const result = await host.request<any>(
              "/api/plugins/official.billing/quote",
              { method: "POST", body: JSON.stringify({ model, usage }) },
            );
            setReceipt(JSON.stringify(result));
          } catch (error) {
            setMessage((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {!requestPriced && (
          <div className="form-grid">
            {[
              ["input", tr("总输入 Token")],
              ["output", tr("总输出 Token")],
              ["cacheRead", tr("其中缓存读取")],
              ["cacheWrite", tr("其中缓存写入")],
              ["cacheWrite1h", tr("其中 1 小时写入")],
            ].map(([key, title]) => (
              <label key={key}>
                {title}
                <input
                  name={key}
                  type="number"
                  min="0"
                  step="1"
                  defaultValue={
                    key === "input" ? 1000 : key === "output" ? 500 : 0
                  }
                  required
                />
              </label>
            ))}
          </div>
        )}
        <button disabled={busy}>{tr("计算费用")}</button>
      </form>
      <Notice message={message} />
      {receipt && (
        <>
          <output aria-label={tr("预估费用")}>
            ${(JSON.parse(receipt).amount / 1e6).toFixed(6)}
          </output>
          <PriceReceiptView value={receipt} />
        </>
      )}
    </details>
  );
}
