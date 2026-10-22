import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { t as tr } from "../../lib/ui/i18n.js";
import { useLoad, Notice } from "../../lib/ui/mount.js";
import { Select } from "../../lib/ui/select.js";
import { Dialog, Icon } from "../../lib/ui/components.js";
import { pluginCategoryTitle } from "./plugin-list.js";
type Source = {
  id: string;
  name: string;
  url: string;
  builtin?: boolean;
  enabled?: boolean;
  allowPrivateNetwork?: boolean;
};
type Item = {
  manifest: {
    id: string;
    name?: string;
    version: string;
    description?: string;
    category?: string;
  };
  registryId: string;
  registryName: string;
  compatible: boolean;
  updateAvailable: boolean;
};
const pluginTitle = (manifest: { id: string; name?: string }) =>
  manifest.id.startsWith("official.")
    ? tr(manifest.name ?? manifest.id)
    : (manifest.name ?? manifest.id);
export function PluginUpdates({ client }: { client: UIHost }) {
  const status = useLoad<any>(() => client.request("/api/host/plugin-updates"));
  const [busy, setBusy] = React.useState(false),
    [message, setMessage] = React.useState("");
  const job = status.data;
  return (
    <>
      <Notice message={message || status.error} />
      {job && !["cancelled", "applied"].includes(job.state) && (
        <div className="card">
          <div className="actions">
            <strong>
              {job.state === "failed"
                ? tr("更新未生效，已恢复旧版本")
                : tr("插件更新待重启")}
            </strong>
            <code>{job.pluginId}</code>
            {job.state === "pending" && (
              <>
                <button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await client.request("/api/host/plugin-updates/apply", {
                        method: "POST",
                        body: JSON.stringify({ id: job.id }),
                      });
                      setMessage(tr("正在重启，请稍候…"));
                      for (let i = 0; i < 90; i++) {
                        await new Promise((resolve) =>
                          setTimeout(resolve, 1000),
                        );
                        try {
                          const response = await fetch(
                            "/api/host/plugin-updates",
                            { credentials: "same-origin", cache: "no-store" },
                          );
                          if (!response.ok) continue;
                          const next = await response.json();
                          if (
                            next?.id === job.id &&
                            ["applied", "failed"].includes(next.state)
                          ) {
                            location.reload();
                            return;
                          }
                        } catch {}
                      }
                      setMessage(tr("请刷新查看更新状态"));
                    } catch (e) {
                      setMessage((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {tr("应用更新并重启")}
                </button>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={async () => {
                    try {
                      await client.request("/api/host/plugin-updates/cancel", {
                        method: "POST",
                        body: JSON.stringify({ id: job.id }),
                      });
                      status.reload();
                    } catch (e) {
                      setMessage((e as Error).message);
                    }
                  }}
                >
                  {tr("取消更新")}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
export function RegistryBrowser({
  client,
  installed,
  focusId,
  close,
  done,
}: {
  client: UIHost;
  installed: any[];
  focusId?: string;
  close: () => void;
  done: () => void;
}) {
  const catalog = useLoad<{
    plugins: Item[];
    errors: { registryId: string; code: string }[];
  }>(() => client.request("/api/host/registry/catalog"));
  const sources = useLoad<Source[]>(() =>
    client.request("/api/host/registry/sources"),
  );
  const [source, setSource] = React.useState(""),
    [q, setQ] = React.useState(focusId ?? ""),
    [category, setCategory] = React.useState("");
  const [manage, setManage] = React.useState(false),
    [message, setMessage] = React.useState(""),
    [busy, setBusy] = React.useState(false);
  const [review, setReview] = React.useState<any>(),
    [approved, setApproved] = React.useState<Record<string, boolean>>({}),
    [reason, setReason] = React.useState("");
  const [config, setConfig] = React.useState("{}"),
    [dependencyConfigs, setDependencyConfigs] = React.useState("{}");
  const categories = [
    ...new Set(
      catalog.data?.plugins.map((p) => p.manifest.category).filter(Boolean),
    ),
  ];
  const groups = new Map<string, Item[]>();
  for (const item of catalog.data?.plugins ?? []) {
    const key = item.registryId + ":" + item.manifest.id;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const rows = [...groups.values()].filter(
    (items) =>
      (!source || items[0]!.registryId === source) &&
      (!category || items[0]!.manifest.category === category) &&
      (!q ||
        JSON.stringify(items[0]!.manifest)
          .toLowerCase()
          .includes(q.toLowerCase())),
  );
  return (
    <Dialog
      title={tr("在线插件目录")}
      close={() => {
        if (!busy) close();
      }}
    >
      <style>{`.registry-mobile-meta{display:none}@media(max-width:640px){table.registry-catalog{min-width:0!important;width:100%;table-layout:fixed}.registry-catalog th:first-child,.registry-catalog td:first-child{width:68%}.registry-catalog th:nth-child(2),.registry-catalog td:nth-child(2),.registry-catalog th:nth-child(3),.registry-catalog td:nth-child(3){display:none}.registry-catalog td{overflow-wrap:anywhere}.registry-catalog td code{word-break:break-all}.registry-mobile-meta{display:block;color:var(--muted);font-size:11px;margin-top:4px}.registry-mobile-meta span{display:block;margin-top:3px}.registry-catalog button{white-space:normal;height:auto;min-height:30px;padding:5px 8px;font-size:12px;max-width:100%}}`}</style>
      <Notice message={message || catalog.error || sources.error} />
      {catalog.data?.errors.map((error) => (
        <Notice
          key={error.registryId}
          message={error.registryId + ": " + error.code}
        />
      ))}
      {manage ? (
        <RegistrySources
          client={client}
          initial={sources.data ?? []}
          done={() => {
            setManage(false);
            sources.reload();
            catalog.reload();
          }}
        />
      ) : review ? (
        <>
          <h3>
            {pluginTitle(review.item.manifest)} · {review.item.manifest.version}
          </h3>
          <p>
            {review.plan.mode === "restart-update"
              ? tr("下载后需重启应用")
              : review.plan.mode === "hot-update"
                ? tr("可热更新")
                : tr("确认插件与依赖")}
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{tr("插件")}</th>
                  <th>{tr("版本")}</th>
                  <th>{tr("注册源")}</th>
                  <th>{tr("权限授权")}</th>
                </tr>
              </thead>
              <tbody>
                {review.plan.plugins.map((plugin: any) => (
                  <tr key={plugin.id}>
                    <td>{pluginTitle(plugin)}</td>
                    <td>{plugin.version}</td>
                    <td>
                      {review.plan.origins[plugin.id]?.registryId ??
                        tr("已安装")}
                    </td>
                    <td>
                      {plugin.action === "keep" ? (
                        tr("保持现有授权")
                      ) : plugin.permissions.length ? (
                        <label className="checkbox">
                          <input
                            type="checkbox"
                            checked={!!approved[plugin.id]}
                            onChange={(e) =>
                              setApproved({
                                ...approved,
                                [plugin.id]: e.target.checked,
                              })
                            }
                          />
                          {plugin.permissions.join(", ")}
                        </label>
                      ) : (
                        tr("无需额外权限")
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label>
            {tr("操作原因")}
            <input
              value={reason}
              maxLength={256}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setReview(undefined)}
            >
              {tr("返回")}
            </button>
            <button
              disabled={
                busy ||
                !reason.trim() ||
                review.plan.plugins.some(
                  (p: any) =>
                    p.action === "install" &&
                    p.permissions.length &&
                    !approved[p.id],
                )
              }
              onClick={async () => {
                setBusy(true);
                try {
                  const additions = review.plan.plugins.filter(
                    (p: any) => p.action === "install",
                  );
                  await client.request("/api/host/registry/install", {
                    method: "POST",
                    body: JSON.stringify({
                      ...review.input,
                      expectedPlan: review.plan.fingerprint,
                      reason,
                      grants:
                        additions.find((p: any) => p.id === review.input.id)
                          ?.permissions ?? [],
                      dependencyGrants: Object.fromEntries(
                        additions
                          .filter((p: any) => p.id !== review.input.id)
                          .map((p: any) => [p.id, p.permissions]),
                      ),
                    }),
                  });
                  done();
                  close();
                } catch (e) {
                  setMessage((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? tr("正在安装…") : tr("确认安装 / 更新")}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="list-toolbar">
            <input
              type="search"
              aria-label={tr("搜索在线插件")}
              placeholder={tr("搜索插件")}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <Select
              aria-label={tr("注册源")}
              value={source}
              onChange={(e) => setSource(e.target.value)}
            >
              <option value="">{tr("全部注册源")}</option>
              {sources.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
            <Select
              aria-label={tr("插件分类")}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">{tr("全部分类")}</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {pluginCategoryTitle(c!)}
                </option>
              ))}
            </Select>
            <button
              className="secondary"
              onClick={() => {
                catalog.reload();
                sources.reload();
              }}
            >
              <Icon name="refresh" size={14} />
              {tr("刷新")}
            </button>
            <button className="secondary" onClick={() => setManage(true)}>
              {tr("管理注册源")}
            </button>
          </div>
          <div className="table-wrap">
            <table className="registry-catalog">
              <thead>
                <tr>
                  <th>{tr("插件")}</th>
                  <th>{tr("注册源")}</th>
                  <th>{tr("版本")}</th>
                  <th>{tr("操作")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((items) => (
                  <RegistryRow
                    key={items[0]!.registryId + items[0]!.manifest.id}
                    items={items}
                    current={installed.find(
                      (p) => p.id === items[0]!.manifest.id,
                    )}
                    busy={busy}
                    choose={async (item) => {
                      setBusy(true);
                      setMessage("");
                      try {
                        const current = installed.find(
                            (p) => p.id === item.manifest.id,
                          ),
                          input = {
                            id: item.manifest.id,
                            version: item.manifest.version,
                            registryId: item.registryId,
                            operation: current ? "update" : "install",
                            revision: current?.revision,
                            config: JSON.parse(config),
                            dependencyConfigs: JSON.parse(dependencyConfigs),
                          };
                        const plan = await client.request<any>(
                          "/api/host/registry/plan",
                          { method: "POST", body: JSON.stringify(input) },
                        );
                        setReview({ item, input, plan });
                        setApproved({});
                        setReason("");
                      } catch (e) {
                        setMessage((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  />
                ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={4}>
                      {catalog.data ? tr("没有匹配的插件") : tr("正在加载…")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <details>
            <summary>{tr("初始配置")}</summary>
            <label>
              {tr("插件配置 JSON")}
              <textarea
                value={config}
                onChange={(e) => setConfig(e.target.value)}
              />
            </label>
            <label>
              {tr("依赖插件配置 JSON")}
              <textarea
                value={dependencyConfigs}
                onChange={(e) => setDependencyConfigs(e.target.value)}
              />
            </label>
          </details>
        </>
      )}
    </Dialog>
  );
}
function RegistryRow({
  items,
  current,
  busy,
  choose,
}: {
  items: Item[];
  current?: any;
  busy: boolean;
  choose: (item: Item) => void;
}) {
  const [version, setVersion] = React.useState(items[0]!.manifest.version),
    item = items.find((i) => i.manifest.version === version) ?? items[0]!;
  return (
    <tr>
      <td>
        <strong>{pluginTitle(item.manifest)}</strong>
        <div className="muted">
          <code>{item.manifest.id}</code>
        </div>
        {current && (
          <small>{tr("当前版本 {0}", { "0": current.version })}</small>
        )}
        <div className="registry-mobile-meta">
          <Select
            aria-label={tr("插件版本")}
            value={version}
            onChange={(e) => setVersion(e.target.value)}
          >
            {items.map((i) => (
              <option key={i.manifest.version} value={i.manifest.version}>
                {i.manifest.version}
              </option>
            ))}
          </Select>
          <span>{item.registryName}</span>
        </div>
      </td>
      <td>{item.registryName}</td>
      <td>
        <Select
          aria-label={tr("插件版本")}
          value={version}
          onChange={(e) => setVersion(e.target.value)}
        >
          {items.map((i) => (
            <option key={i.manifest.version} value={i.manifest.version}>
              {i.manifest.version}
            </option>
          ))}
        </Select>
      </td>
      <td>
        <button
          className="secondary"
          disabled={
            busy || !item.compatible || (!!current && !item.updateAvailable)
          }
          onClick={() => choose(item)}
        >
          {!item.compatible
            ? tr("宿主版本不兼容")
            : !!current && !item.updateAvailable
              ? current.version === version
                ? tr("已安装")
                : tr("较早版本")
              : current
                ? tr("更新")
                : tr("安装")}
        </button>
      </td>
    </tr>
  );
}
function RegistrySources({
  client,
  initial,
  done,
}: {
  client: UIHost;
  initial: Source[];
  done: () => void;
}) {
  const [rows, setRows] = React.useState(
      initial.filter((s) => s.id !== "official"),
    ),
    [message, setMessage] = React.useState(""),
    [busy, setBusy] = React.useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await client.request("/api/host/registry/sources", {
            method: "PUT",
            body: JSON.stringify({ sources: rows }),
          });
          done();
        } catch (error) {
          setMessage((error as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Notice message={message} />
      <p>
        PluHub ·{" "}
        {initial.find((s) => s.id === "official")?.url === "builtin:official"
          ? tr("官方发布快照")
          : initial.find((s) => s.id === "official")?.url}
      </p>
      {rows.map((source, index) => (
        <div key={index} className="card form-grid">
          <label>
            ID
            <input
              required
              pattern="[a-z](?:[a-z0-9]|-){0,63}"
              value={source.id}
              onChange={(e) =>
                setRows(
                  rows.map((s, i) =>
                    i === index ? { ...s, id: e.target.value } : s,
                  ),
                )
              }
            />
          </label>
          <label>
            {tr("名称")}
            <input
              required
              value={source.name}
              onChange={(e) =>
                setRows(
                  rows.map((s, i) =>
                    i === index ? { ...s, name: e.target.value } : s,
                  ),
                )
              }
            />
          </label>
          <label>
            URL
            <input
              required
              type="url"
              value={source.url}
              onChange={(e) =>
                setRows(
                  rows.map((s, i) =>
                    i === index ? { ...s, url: e.target.value } : s,
                  ),
                )
              }
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={source.enabled !== false}
              onChange={(e) =>
                setRows(
                  rows.map((s, i) =>
                    i === index ? { ...s, enabled: e.target.checked } : s,
                  ),
                )
              }
            />
            {tr("启用")}
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={!!source.allowPrivateNetwork}
              onChange={(e) =>
                setRows(
                  rows.map((s, i) =>
                    i === index
                      ? { ...s, allowPrivateNetwork: e.target.checked }
                      : s,
                  ),
                )
              }
            />
            {tr("允许内网注册源")}
          </label>
          <button
            type="button"
            className="ghost danger"
            onClick={() => setRows(rows.filter((_, i) => i !== index))}
          >
            {tr("删除")}
          </button>
        </div>
      ))}
      <div className="actions">
        <button
          type="button"
          className="secondary"
          onClick={() => setRows([...rows, { id: "", name: "", url: "" }])}
        >
          {tr("添加注册源")}
        </button>
        <button type="button" className="secondary" onClick={done}>
          {tr("返回")}
        </button>
        <button disabled={busy}>{tr("保存")}</button>
      </div>
    </form>
  );
}
