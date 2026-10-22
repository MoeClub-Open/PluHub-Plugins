import { Checkbox } from "../../lib/ui/checkbox.js";
import { t as tr } from "../../lib/ui/i18n.js";
import { Select } from "../../lib/ui/select.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { mountPage, useLoad, Notice } from "../../lib/ui/mount.js";
import { migrateLegacyChannels } from "../../lib/ai/channel-config.js";
function Page({ host }: { host: UIHost }) {
  const status = useLoad<any>(() =>
    host.request("/api/plugins/official.token-speed/status"),
  );
  const [enabled, setEnabled] = React.useState(false);
  const [rate, setRate] = React.useState(30);
  const [aggregate, setAggregate] = React.useState<number | undefined>();
  const [tokenizer, setTokenizer] = React.useState("o200k_base");
  const [definitions, setDefinitions] = React.useState("{}");
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (!status.data) return;
    const c = status.data.config;
    setEnabled(!!c.default);
    setRate(c.default?.tps ?? 30);
    setAggregate(c.default?.aggregateTps);
    setTokenizer(c.default?.tokenizer ?? "o200k_base");
    setDefinitions(JSON.stringify(c.tokenizers ?? {}, null, 2));
  }, [status.data]);
  async function save() {
    setBusy(true);
    try {
      const c = await host.request<any>("/api/host/config");
      migrateLegacyChannels(c);
      const p = c.plugins.find((p: any) =>
        /\/(?:official\.)?token-speed$/.test(p.path.replaceAll("\\", "/")),
      );
      if (!p) throw new Error(tr("TPS 插件尚未安装"));
      p.config = { ...p.config, tokenizers: JSON.parse(definitions) };
      if (enabled)
        p.config.default = {
          tps: rate,
          tokenizer,
          ...(aggregate ? { aggregateTps: aggregate } : {}),
        };
      else delete p.config.default;
      await host.request("/api/host/config", {
        method: "PUT",
        body: JSON.stringify(c),
      });
      setMessage(tr("已保存"));
      status.reload();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const names: string[] = status.data?.tokenizers ?? [
    "o200k_base",
    "cl100k_base",
  ];
  return (
    <>
      <h2>{tr("默认输出速度")}</h2>
      <Notice message={message || status.error} />
      {status.data && (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="checkbox">
            <Checkbox
              appearance="switch"
              checked={enabled}
              onCheckedChange={(e) => setEnabled(e === true)}
            />
            {tr("启用默认单请求限速")}
          </label>
          {enabled && (
            <div className="form-grid">
              <label>
                {tr("每请求输出 TPS")}
                <input
                  type="number"
                  min=".1"
                  step=".1"
                  value={rate}
                  onChange={(e) => setRate(Number(e.target.value))}
                  required
                />
              </label>
              <label>
                {tr("分词器")}
                <Select
                  value={tokenizer}
                  onChange={(e) => setTokenizer(e.target.value)}
                >
                  {names.map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </Select>
              </label>
              <label>
                {tr("共享模型 TPS")}
                <input
                  type="number"
                  min=".1"
                  step=".1"
                  value={aggregate ?? ""}
                  onChange={(e) =>
                    setAggregate(Number(e.target.value) || undefined)
                  }
                />
              </label>
            </div>
          )}
          <details>
            <summary>{tr("自定义模型 tokenizer")}</summary>
            <textarea
              className="code"
              rows={5}
              aria-label={tr("自定义 tokenizer 配置")}
              value={definitions}
              onChange={(e) => setDefinitions(e.target.value)}
            />
          </details>
          <div className="actions">
            <button disabled={busy}>{tr("保存默认限速")}</button>
          </div>
        </form>
      )}
    </>
  );
}
export const mount = (el: HTMLElement, host: UIHost) =>
  mountPage(el, host, Page);
