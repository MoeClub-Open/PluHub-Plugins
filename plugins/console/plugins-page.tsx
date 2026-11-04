import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { t as tr, textValue } from "../../lib/ui/i18n.js";
import { Select } from "../../lib/ui/select.js";
import { Icon, PageHeading, Empty } from "../../lib/ui/components.js";
import { PluginActions } from "./plugin-actions.js";
import { RegistryBrowser, PluginUpdates } from "./registry-ui.js";
import {
  filterPlugins,
  pluginCategory,
  pluginCategoryTitle,
  pluginCategoryOptions,
  pluginStates,
} from "./plugin-list.js";

export function PluginsPage({
  client,
  version,
  onRefresh,
  onMessage,
}: {
  client: UIHost;
  version: number;
  onRefresh: () => void;
  onMessage: (message: string) => void;
}) {
  const [plugins, setPlugins] = React.useState<any[]>([]);
  const [pluginQuery, setPluginQuery] = React.useState("");
  const [pluginCategoryFilter, setPluginCategoryFilter] = React.useState("");
  const [pluginStateFilter, setPluginStateFilter] = React.useState("");
  const [updatePlugin, setUpdatePlugin] = React.useState<any>();
  const [availableUpdates, setAvailableUpdates] = React.useState<
    Record<string, string>
  >({});
  const [updateCheck, setUpdateCheck] = React.useState("");

  React.useEffect(() => {
    void client
      .request<any[]>("/api/host/plugins")
      .then(setPlugins)
      .catch((error) => onMessage(error.message));
  }, [version, client]);

  React.useEffect(() => {
    let active = true;
    setAvailableUpdates({});
    setUpdateCheck(tr("正在检查插件更新…"));
    void Promise.all([
      client.request<any>("/api/host/registry/catalog"),
      client.request<any[]>("/api/host/registry/sources"),
    ]).then(
      ([catalog, sources]) => {
        if (!active) return;
        const updates: Record<string, string> = {};
        for (const item of catalog.plugins ?? [])
          if (
            item.compatible &&
            item.updateAvailable &&
            !updates[item.manifest.id]
          )
            updates[item.manifest.id] = item.manifest.version;
        setAvailableUpdates(updates);
        const errors = (catalog.errors ?? [])
          .map((item: any) => item.registryId)
          .join(", ");
        setUpdateCheck(
          errors
            ? tr("部分注册源检查失败：{0}", { "0": errors })
            : !sources.some((source) => {
                  if (source.enabled === false || source.builtin) return false;
                  try {
                    const url = new URL(source.url, window.location.href);
                    return (
                      url.origin !== window.location.origin ||
                      url.pathname !== "/registry/v1/index.json"
                    );
                  } catch {
                    return false;
                  }
                })
              ? tr("当前仅有内置插件目录，配置在线注册源后可检查新版本。")
              : Object.keys(updates).length
                ? tr("{0} 个插件有可用更新", {
                    "0": String(Object.keys(updates).length),
                  })
                : tr("已检查插件更新"),
        );
      },
      (error) => {
        if (active)
          setUpdateCheck(
            tr("插件更新检查失败：{0}", { "0": (error as Error).message }),
          );
      },
    );
    return () => {
      active = false;
    };
  }, [version, client]);

  const categories = pluginCategoryOptions(plugins);
  const visiblePlugins = filterPlugins(
    plugins,
    pluginQuery,
    pluginCategoryFilter,
    pluginStateFilter,
  );
  const pluginFiltersActive = !!(
    pluginQuery ||
    pluginCategoryFilter ||
    pluginStateFilter
  );
  function resetPluginFilters() {
    setPluginQuery("");
    setPluginCategoryFilter("");
    setPluginStateFilter("");
  }

  return (
    <>
      <PluginUpdates key={version} client={client} />
      <PageHeading title={tr("插件管理")}>
        <button onClick={() => setUpdatePlugin({})}>
          <Icon name="plus" size={15} />
          {tr("在线安装")}
        </button>
        <span className="plugin-running">
          <i className="status-dot" />
          {plugins.filter((p) => p.state === "Active").length}{" "}
          {tr("个运行中")}
        </span>
        <button className="secondary" onClick={onRefresh}>
          <Icon name="refresh" size={16} />
          {tr("检查更新")}
        </button>
      </PageHeading>
      {updateCheck && (
        <p className="muted" role="status">
          {updateCheck}
        </p>
      )}
      <div className="list-toolbar plugin-filters">
        <input
          type="search"
          aria-label={tr("搜索插件")}
          placeholder={tr("搜索名称、ID、用途或分类")}
          value={pluginQuery}
          onChange={(e) => setPluginQuery(e.target.value)}
        />
        <Select
          aria-label={tr("插件分类")}
          value={pluginCategoryFilter}
          onChange={(e) => setPluginCategoryFilter(e.target.value)}
        >
          <option value="">
            {tr("全部分类（{0}）", { "0": textValue(plugins.length) })}
          </option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.title}（{category.count}）
            </option>
          ))}
          {pluginCategoryFilter &&
            !categories.some((c) => c.id === pluginCategoryFilter) && (
              <option value={pluginCategoryFilter}>
                {pluginCategoryTitle(pluginCategoryFilter)}（0）
              </option>
            )}
        </Select>
        <Select
          aria-label={tr("插件状态")}
          value={pluginStateFilter}
          onChange={(e) => setPluginStateFilter(e.target.value)}
        >
          <option value="">{tr("全部状态")}</option>
          {Object.entries(pluginStates)
            .filter(
              ([state]) =>
                plugins.some((plugin) => plugin.state === state) ||
                state === pluginStateFilter,
            )
            .map(([state, title]) => (
              <option key={state} value={state}>
                {title}
              </option>
            ))}
        </Select>
        {pluginFiltersActive && (
          <button className="ghost" onClick={resetPluginFilters}>
            {tr("清除筛选")}
          </button>
        )}
        <span className="plugin-result-count" role="status">
          {tr("显示 {0} / {1} 个插件", {
            "0": textValue(visiblePlugins.length),
            "1": textValue(plugins.length),
          })}
        </span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{tr("插件")}</th>
              <th>{tr("分类")}</th>
              <th>{tr("版本")}</th>
              <th>{tr("状态")}</th>
              <th>{tr("更新方式")}</th>
              <th>{tr("操作")}</th>
            </tr>
          </thead>
          <tbody>
            {visiblePlugins.map((p) => (
              <tr key={p.id}>
                <td
                  title={
                    p.id.startsWith("official.")
                      ? tr(p.description || p.manifest.description || "")
                      : p.description || p.manifest.description
                  }
                >
                  <strong>
                    {p.id.startsWith("official.")
                      ? tr(p.name || p.manifest.name || p.id)
                      : p.name || p.manifest.name || p.id}
                  </strong>
                  <small>
                    <code>{p.id}</code>
                  </small>
                </td>
                <td>
                  <span className="badge">
                    {pluginCategoryTitle(pluginCategory(p))}
                  </span>
                </td>
                <td>
                  <code>{p.version}</code>
                  {availableUpdates[p.id] && (
                    <small>
                      {tr("可更新至 {0}", { "0": availableUpdates[p.id] })}
                    </small>
                  )}
                </td>
                <td>
                  <span
                    className={
                      "badge " + (p.state === "Active" ? "ready" : "")
                    }
                  >
                    {pluginStates[p.state] ?? p.state}
                  </span>
                </td>
                <td
                  title={
                    p.manifest.configReload === "snapshot"
                      ? tr("配置即时生效")
                      : tr("配置需重启")
                  }
                >
                  <span
                    className={
                      "badge " + (p.codeReload === "parallel" ? "ready" : "")
                    }
                  >
                    {p.codeReload === "parallel"
                      ? tr("可热更新")
                      : tr("重启应用")}
                  </span>
                </td>
                <td>
                  {availableUpdates[p.id] && (
                    <button
                      className="ghost"
                      onClick={() => setUpdatePlugin(p)}
                    >
                      {tr("更新")}
                    </button>
                  )}
                  <PluginActions
                    plugin={p}
                    host={client}
                    changed={onRefresh}
                    report={onMessage}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {plugins.length > 0 && visiblePlugins.length === 0 && (
        <Empty title={tr("没有匹配的插件")} />
      )}
      {updatePlugin && (
        <RegistryBrowser
          client={client}
          installed={plugins}
          focusId={updatePlugin.id}
          close={() => setUpdatePlugin(undefined)}
          done={() => {
            setUpdatePlugin(undefined);
            onRefresh();
            onMessage(tr("插件已更新"));
          }}
        />
      )}
    </>
  );
}
