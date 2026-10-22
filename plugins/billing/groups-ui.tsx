import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { t as tr } from "../../lib/ui/i18n.js";
import { useLoad, Notice } from "../../lib/ui/mount.js";
import { Select } from "../../lib/ui/select.js";
import type { OutputBudgetMode } from "../../lib/ai/output-budget.js";

export function BillingGroups({ host }: { host: UIHost }) {
  const config = useLoad<any>(() => host.request("/api/host/config"));
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [groups, setGroups] = React.useState<
    { id: string; name: string; multiplier: number }[]
  >([]);
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
      setGroups(
        Object.entries({
          default: { name: tr("默认分组"), multiplier: 1 },
          ...plugin.config?.groups,
        }).map(([id, group]: [string, any]) => ({ id, ...group })),
      );
    }
  }, [config.data]);
  return (
    <section className="card">
      <h2>{tr("分组与输出预算")}</h2>
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
            if (new Set(groups.map((g) => g.id)).size !== groups.length)
              throw new Error(tr("分组 ID 不能重复"));
            plugin.config = {
              ...plugin.config,
              reserveOutputTokens,
              outputBudgetMode,
              groups: Object.fromEntries(
                groups.map(({ id, ...value }) => [id, value]),
              ),
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
        <p className="muted">
          {outputBudgetMode === "bounded"
            ? tr("不支持输出上限的按 Token 计费上游将拒绝调用。")
            : outputBudgetMode === "estimate"
              ? tr("只预留估算额度，不限制上游输出。")
              : tr(
                  "支持输出上限时同步预留与发送上限；其他上游保留估算并在调用记录中标明。",
                )}
        </p>
        <div className="table-wrap">
          <table style={{ minWidth: 600 }}>
            <thead>
              <tr>
                <th>ID</th>
                <th>{tr("名称")}</th>
                <th>{tr("消耗倍率")}</th>
                <th>{tr("操作")}</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group, index) => (
                <tr key={index}>
                  <td>
                    <input
                      aria-label={tr("分组 ID")}
                      value={group.id}
                      disabled={index === 0}
                      required
                      pattern="[a-zA-Z0-9_.-]{1,64}"
                      onChange={(e) =>
                        setGroups(
                          groups.map((g, i) =>
                            i === index ? { ...g, id: e.target.value } : g,
                          ),
                        )
                      }
                    />
                  </td>
                  <td>
                    <input
                      aria-label={tr("分组名称")}
                      value={group.name}
                      required
                      maxLength={64}
                      onChange={(e) =>
                        setGroups(
                          groups.map((g, i) =>
                            i === index ? { ...g, name: e.target.value } : g,
                          ),
                        )
                      }
                    />
                  </td>
                  <td>
                    <input
                      aria-label={tr("分组消耗倍率")}
                      type="number"
                      min="0"
                      max="1000"
                      step="any"
                      value={group.multiplier}
                      required
                      onChange={(e) =>
                        setGroups(
                          groups.map((g, i) =>
                            i === index
                              ? { ...g, multiplier: Number(e.target.value) }
                              : g,
                          ),
                        )
                      }
                    />
                  </td>
                  <td>
                    {index > 0 && (
                      <button
                        type="button"
                        className="ghost danger"
                        onClick={() =>
                          setGroups(groups.filter((_, i) => i !== index))
                        }
                      >
                        {tr("删除")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="actions">
          <button
            type="button"
            className="secondary"
            onClick={() =>
              setGroups([
                ...groups,
                {
                  id: "group-" + crypto.randomUUID().slice(0, 8),
                  name: "",
                  multiplier: 1,
                },
              ])
            }
          >
            {tr("添加分组")}
          </button>
          <button disabled={busy || !config.data}>{tr("保存并应用")}</button>
        </div>
      </form>
    </section>
  );
}
