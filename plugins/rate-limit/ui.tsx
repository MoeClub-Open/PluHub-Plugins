import { t as tr } from "../../lib/ui/i18n.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { mountPage, useLoad, Notice } from "../../lib/ui/mount.js";
import { updatePluginConfig } from "../../lib/ui/plugin-config.js";
function Page({ host }: { host: UIHost }) {
  const data = useLoad<any>(() =>
    host.request("/api/plugins/official.rate-limit/status"),
  );
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const f = new FormData(e.currentTarget);
    try {
      await updatePluginConfig(host, "official.rate-limit", (current) => {
        const next: Record<string, any> = { channels: current?.channels ?? {} };
        for (const scope of ["user", "key"]) {
          const rule: Record<string, number> = {};
          for (const field of ["rpm", "tpm", "concurrency"]) {
            const value = Number(f.get(scope + "." + field));
            if (value > 0) rule[field] = value;
          }
          if (Object.keys(rule).length) next[scope] = rule;
        }
        const rate = Number(f.get("bytesPerSecond"));
        if (rate > 0) next.bytesPerSecond = rate;
        return next;
      });
      setMessage(tr("流量策略已应用"));
      data.reload();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <h2>{tr("全局请求限制")}</h2>
      <Notice message={message || data.error} />
      {data.data && (
        <form
          className="card"
          onSubmit={save}
          key={JSON.stringify(data.data.config)}
        >
          <div className="form-grid">
            {["user", "key"].map((scope) => (
              <React.Fragment key={scope}>
                <h3 className="full">
                  {scope === "user" ? tr("每位用户") : tr("每个 API Key")}
                </h3>
                {[
                  ["rpm", tr("每分钟请求")],
                  ["tpm", tr("每分钟 Token")],
                  ["concurrency", tr("最大并发")],
                ].map(([field, title]) => (
                  <label key={field}>
                    {title}
                    <input
                      name={scope + "." + field}
                      type="number"
                      min="0"
                      step="1"
                      defaultValue={data.data.config[scope]?.[field] ?? 0}
                    />
                  </label>
                ))}
              </React.Fragment>
            ))}
            <label>
              {tr("响应带宽（字节 / 秒）")}
              <input
                name="bytesPerSecond"
                type="number"
                min="0"
                step="1"
                defaultValue={data.data.config.bytesPerSecond ?? 0}
              />
            </label>
          </div>
          <p className="field-note">{tr("0 表示不限。")}</p>
          <button disabled={busy}>{tr("保存全局限制")}</button>
        </form>
      )}
    </>
  );
}
export const mount = (el: HTMLElement, host: UIHost) =>
  mountPage(el, host, Page);
