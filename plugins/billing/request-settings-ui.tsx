import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { t as tr } from "../../lib/ui/i18n.js";
import { Notice } from "../../lib/ui/mount.js";
import { usePluginConfig } from "../../lib/ui/plugin-config.js";
import { Select } from "../../lib/ui/select.js";
import type { OutputBudgetMode } from "../../lib/ai/output-budget.js";

export function RequestBillingSettings({ host }: { host: UIHost }) {
  const config = usePluginConfig(host, "official.billing");
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [reserveOutputTokens, setReserveOutputTokens] = React.useState(4096);
  const [personalRequestFee, setPersonalRequestFee] = React.useState(0);
  const [outputBudgetMode, setOutputBudgetMode] =
    React.useState<OutputBudgetMode>("automatic");
  React.useEffect(() => {
    if (config.data) {
      setReserveOutputTokens(config.data.reserveOutputTokens ?? 4096);
      setPersonalRequestFee(config.data.personalRequestFee ?? 0);
      setOutputBudgetMode(config.data.outputBudgetMode ?? "automatic");
    }
  }, [config.data]);
  return (
    <section className="card">
      <h2>{tr("请求计费")}</h2>
      <Notice message={message || config.error} />
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setMessage("");
          try {
            await config.save((current) => ({
              ...current,
              reserveOutputTokens,
              outputBudgetMode,
              personalRequestFee,
            }));
            setMessage(tr("已保存"));
          } catch (error) {
            setMessage((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-grid">
          <label className="full">
            {tr("个人渠道请求手续费（USD / 次）")}
            <input
              type="number"
              min="0"
              max="1000000"
              step="0.000001"
              required
              value={personalRequestFee}
              onChange={(event) =>
                setPersonalRequestFee(Number(event.target.value))
              }
            />
            <small>{tr("设为 0 不收取；上游模型费用仍由用户自行结算。")}</small>
          </label>
          <label>
            {tr("输出预算策略")}
            <Select
              value={outputBudgetMode}
              onChange={(e) =>
                setOutputBudgetMode(e.target.value as OutputBudgetMode)
              }
            >
              <option value="automatic">{tr("自动应用输出上限")}</option>
              <option value="bounded">{tr("强制输出上限")}</option>
              <option value="estimate">{tr("仅估算预留")}</option>
            </Select>
          </label>
          <label>
            {tr("默认输出预算（Token）")}
            <input
              type="number"
              min="1"
              max={outputBudgetMode === "estimate" ? 100000000 : 1000000}
              step="1"
              required
              value={reserveOutputTokens}
              onChange={(e) => setReserveOutputTokens(Number(e.target.value))}
            />
          </label>
        </div>
        <div className="actions">
          <button disabled={busy || !config.data}>{tr("保存并应用")}</button>
        </div>
      </form>
    </section>
  );
}
