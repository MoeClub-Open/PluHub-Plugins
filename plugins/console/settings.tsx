import { t as tr } from "../../lib/ui/i18n.js";
import type { Extension } from "@pluhub/ui-sdk";
import { Icon } from "../../lib/ui/components.js";
import type { SettingsSection } from "./navigation.js";

export function SettingsNavigation({
  sections,
  selectedPath,
  management,
  overview,
}: {
  sections: SettingsSection[];
  selectedPath?: string;
  management: Extension[];
  overview: boolean;
}) {
  const system = sections.find((s) => s.id === "system");
  const visible = [
    ...sections.filter((s) => s.id !== "system"),
    ...(system ? [system] : []),
  ];
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
        {visible.map((section) => (
          <div className="settings-nav-section" key={section.id}>
            <span className="nav-label settings-nav-title">
              <Icon name={section.icon} size={15} />
              {section.title}
            </span>
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
      </nav>
    </>
  );
}
