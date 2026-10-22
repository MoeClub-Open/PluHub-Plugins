import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { t as tr } from "../../lib/ui/i18n.js";
import { useLoad, Notice } from "../../lib/ui/mount.js";
import { Select } from "../../lib/ui/select.js";
import type { OutputBudgetMode } from "../../lib/ai/output-budget.js";

export function OutputBudgetSettings({ host }: { host: UIHost }) {
  const config = useLoad<any>(() => host.request("/api/host/config"));
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [reserveOutputTokens, setReserveOutputTokens] = React.useState(4096);
  const [outputBudgetMode, setOutputBudgetMode] =
    React.useState<OutputBudgetMode>("automatic");
  React.useEffect(() => {
    const plugin = config.data?.plugins.find((p: any) =>
      /\/(?:official\.)?billing$/.test(p.path.replaceAll("\\", "/")),
    );
    if (plugin) {
      setReserveOutputTokens(plugin.config?.reserveOutputTokens ?? 4096);
      setOutputBudgetMode(plugin.config?.outputBudgetMode ?? "automatic");
    }
  }, [config.data]);
  return (
    <section className="card">
      <h2>{tr("输出预算")}</h2>
      <Notice message={message || config.error} />
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setMessage("");
          try {
            const fresh = await host.request<any>("/api/host/config");
            const plugin = fresh.plugins.find((p: any) =>
              /\/(?:official\.)?billing$/.test(p.path.replaceAll("\\", "/")),
            );
            if (!plugin) throw new Error(tr("计费插件不可用"));
            plugin.config = {
              ...plugin.config,
              reserveOutputTokens,
              outputBudgetMode,
            };
            await host.request("/api/host/config", {
              method: "PUT",
              body: JSON.stringify(fresh),
            });
            config.reload();
            setMessage(tr("已保存"));
          } catch (error) {
            setMessage((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-grid">
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
