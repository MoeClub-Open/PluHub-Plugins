import { t as tr } from "../../lib/ui/i18n.js";
import React from "react";
import type { Extension } from "@pluhub/ui-sdk";
import { Empty, Icon, PageHeading } from "../../lib/ui/components.js";
import { searchSettings, type SettingsSection } from "./navigation.js";

export function SettingsNavigation({
  sections,
  selectedPath,
  home,
  management,
  overview,
}: {
  sections: SettingsSection[];
  selectedPath?: string;
  home: boolean;
  management: Extension[];
  overview: boolean;
}) {
  const [query, setQuery] = React.useState("");
  const matches = searchSettings(
    sections.filter((s) => s.id !== "system"),
    home ? "" : query,
  );
  const system = sections.find((s) => s.id === "system");
  const visible = [...matches, ...(system ? [system] : [])];
  React.useEffect(() => {
    if (home) setQuery("");
  }, [home]);
  return (
    <>
      <div className="settings-context">
        <a className="settings-back" href="#/console">
          <Icon name="back" size={15} />
          {tr("返回用户前台")}
        </a>
        <h2>{tr("管理后台")}</h2>
      </div>
      <nav className="settings-navigation" aria-label={tr("管理导航")}>
        <a
          href="#/admin"
          className={overview ? "active" : ""}
          aria-current={overview ? "page" : undefined}
        >
          <Icon name="overview" />
          {tr("全站总览")}
        </a>
        {management.map((page) => (
          <a
            key={page.id}
            href={"#" + page.path}
            className={selectedPath === page.path ? "active" : ""}
            aria-current={selectedPath === page.path ? "page" : undefined}
          >
            <Icon name={page.path === "/users" ? "users" : "plugins"} />
            {page.title}
          </a>
        ))}
        <a
          href="#/settings"
          className={home ? "active" : ""}
          aria-current={home ? "page" : undefined}
        >
          <Icon name="overview" />
          {tr("设置总览")}
        </a>
        {!home && (
          <label className="settings-nav-search">
            <Icon name="search" size={15} />
            <input
              type="search"
              aria-label={tr("筛选设置导航")}
              placeholder={tr("查找设置…")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        )}
        {visible.map((section) => (
          <div className="settings-nav-section" key={section.id}>
            <a className="settings-nav-title" href={"#" + section.path}>
              <Icon name={section.icon} size={15} />
              {section.title}
            </a>
            {section.pages.map((page) => (
              <a
                key={page.id}
                href={"#" + page.path}
                className={
                  selectedPath === page.path
                    ? "active settings-nav-page"
                    : "settings-nav-page"
                }
                aria-current={selectedPath === page.path ? "page" : undefined}
              >
                {page.title}
              </a>
            ))}
          </div>
        ))}
        {!matches.length && query && (
          <p className="empty-inline">{tr("没有匹配的设置")}</p>
        )}
      </nav>
    </>
  );
}

export function SettingsHome({ sections }: { sections: SettingsSection[] }) {
  const [query, setQuery] = React.useState("");
  const visible = searchSettings(sections, query);
  return (
    <>
      <PageHeading title={tr("系统设置")} />
      <div className="settings-search-bar">
        <Icon name="search" size={19} />
        <input
          type="search"
          aria-label={tr("搜索全部设置")}
          placeholder={tr("搜索支付、登录、TPS…")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span>
          {visible.reduce((count, section) => count + section.pages.length, 0)}{" "}
          {tr("项设置")}
        </span>
      </div>
      <div className="settings-grid">
        {visible.map((section) => (
          <section className="card settings-category" key={section.id}>
            <div className="settings-category-heading">
              <span className="settings-category-icon">
                <Icon name={section.icon} size={21} />
              </span>
              <div>
                <h2>{section.title}</h2>
              </div>
            </div>
            <div className="settings-category-links">
              {section.pages.map((page) => (
                <a href={"#" + page.path} key={page.id}>
                  <span>{page.title}</span>
                  <Icon name="arrow" size={15} />
                </a>
              ))}
            </div>
          </section>
        ))}
      </div>
      {!visible.length && (
        <Empty
          title={
            sections.length ? tr("没有找到相关设置") : tr("暂无可配置的扩展")
          }
        >
          {query ? (
            <button className="secondary" onClick={() => setQuery("")}>
              {tr("清除搜索")}
            </button>
          ) : (
            <a className="button secondary" href="#/plugins">
              {tr("管理插件")}
            </a>
          )}
        </Empty>
      )}
    </>
  );
}
