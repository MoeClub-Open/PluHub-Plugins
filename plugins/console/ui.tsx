import React from "react";
import { createRoot } from "react-dom/client";
import {
  createClient,
  mountSlot,
  type UIHost,
  type Extension,
  type UIExtensionModule,
} from "@pluhub/ui-sdk";
import { useTheme } from "./theme.js";
import { useLocale } from "../../lib/ui/language.js";
import { LanguageMenu } from "./language-menu.js";
import {
  internationalization,
  initializeLanguage,
  getLocale,
  setSiteLanguage,
  setAccountLanguage,
  syncLanguagePreferences,
  t as tr,
  textValue,
} from "../../lib/ui/i18n.js";
import { usePageTransition } from "./page-transition.js";
import { AccountMenu } from "./account-menu.js";
import { RegistryBrowser, PluginUpdates } from "./registry-ui.js";
import { Dashboard } from "./dashboard.js";
import { Login } from "./login.js";
import {
  navigation,
  paymentMethodsPath,
  verificationPath,
  consoleNavigation,
  loginDestination,
  channelSettingsDestination,
} from "./navigation.js";
import { VerificationSettings } from "./verification-ui.js";
import { SystemStatus } from "./system-status.js";
import { AuditPage } from "./audit-ui.js";
import { RuntimeLogs } from "./logs-ui.js";
import { PaymentMethods } from "./payment-methods.js";
import { SettingsHome, SettingsNavigation } from "./settings.js";
import { BrandMark, BrandingSettings, useBranding } from "./branding-ui.js";
import { CommandSearch } from "./command-search.js";
import { IdentityConfirmation } from "./identity-confirmation.js";
import { Select } from "../../lib/ui/select.js";
import {
  filterPlugins,
  pluginCategory,
  pluginCategoryTitle,
  pluginCategoryOptions,
  pluginStates,
} from "./plugin-list.js";
import { Portal, PortalSettings } from "./portal-ui.js";
import { defaultPortal, type PortalContent } from "./portal.js";
import { Onboarding } from "./onboarding-ui.js";
import { setupRedirect, type SetupState } from "./onboarding.js";
import { Icon, PageHeading, Empty, Dialog } from "../../lib/ui/components.js";
import "./ui.css";
import "./management.css";
import "./stripe.css";
import "./portal.css";
import "./auth.css";
import "./controls.css";
import "./choices.css";
import "./keys.css";
import "./motion.css";
import { en } from "../../lib/ui/locales/en.js";
import { configureMessages } from "../../lib/ui/i18n.js";
const auth = "/api/plugins/official.auth";
function PublicExtension({
  extension,
  client,
  containerRef,
}: {
  extension: Extension;
  client: UIHost;
  containerRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const localTarget = React.useRef<HTMLDivElement>(null);
  const target = containerRef ?? localTarget;
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    let canceled = false;
    let dispose: (() => void) | undefined;
    setError("");
    if (target.current) {
      const element = target.current;
      void import(extension.url)
        .then((mod: UIExtensionModule) => {
          if (!canceled)
            dispose = mod.mount(element, {
              ...client,
              page: extension.path,
              authenticated: false,
            });
        })
        .catch(() => {
          if (!canceled) setError(tr("模型目录暂时无法加载，请重试。"));
        });
    }
    return () => {
      canceled = true;
      dispose?.();
    };
  }, [extension.url, client]);
  return (
    <section className="portal-catalog">
      {error ? (
        <div role="alert">
          {error}
          <button className="secondary" onClick={() => client.refresh()}>
            {tr("重试")}
          </button>
        </div>
      ) : (
        <div ref={target} />
      )}
    </section>
  );
}
function Slot({
  name,
  client,
  version,
}: {
  name: string;
  client: UIHost;
  version: number;
}) {
  const element = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    let gone = false;
    let dispose: (() => void) | undefined;
    if (element.current)
      void mountSlot(element.current, name, client)
        .then((cleanup) => {
          if (gone) cleanup();
          else dispose = cleanup;
        })
        .catch(() => {});
    return () => {
      gone = true;
      dispose?.();
    };
  }, [name, client, version]);
  return <div ref={element} />;
}
const pageIcons: Record<string, string> = {
  "/models": "models",
  "/playground": "chat",
  "/activity": "activity",
  "/leaderboard": "trophy",
  "/auth": "key",
  "/account": "users",
  "/tickets": "support",
  "/settings/tickets": "support",
  "/channels": "channels",
  "/users": "users",
  "/billing": "activity",
  "/commerce": "models",
  "/byok": "channels",
  "/rate-limit": "activity",
  "/auto-router": "route",
  "/token-speed": "activity",
  "/mailer": "mail",
  "/turnstile": "shield",
  "/plugins": "plugins",
  "/status": "activity",
};
function App() {
  useLocale();
  const [user, setUser] = React.useState<any>();
  const [loaded, setLoaded] = React.useState(false);
  const [extensions, setExtensions] = React.useState<Extension[]>([]);
  const [extensionsLoaded, setExtensionsLoaded] = React.useState(false);
  const [plugins, setPlugins] = React.useState<any[]>([]);
  const [hash, setHash] = React.useState(location.hash.slice(1) || "/");
  const [portal, setPortal] = React.useState<PortalContent>(defaultPortal);
  const [publicLoaded, setPublicLoaded] = React.useState(false);
  const [setupState, setSetupState] = React.useState<SetupState>();
  const [setupError, setSetupError] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [mobile, setMobile] = React.useState(false);
  const [version, setVersion] = React.useState(0);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [confirmingIdentity, setConfirmingIdentity] = React.useState(false);
  const identityRequest = React.useRef<{
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
  } | null>(null);
  const confirmIdentity = React.useCallback(() => {
    if (!identityRequest.current) {
      let resolve!: () => void, reject!: (error: Error) => void;
      const promise = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      identityRequest.current = { promise, resolve, reject };
      setConfirmingIdentity(true);
    }
    return identityRequest.current.promise;
  }, []);
  const finishIdentity = React.useCallback((error?: Error) => {
    const pending = identityRequest.current;
    identityRequest.current = null;
    setConfirmingIdentity(false);
    if (error) pending?.reject(error);
    else pending?.resolve();
  }, []);
  React.useEffect(
    () => () => finishIdentity(new Error(tr("操作已取消"))),
    [hash, user?.id, finishIdentity],
  );
  const [pluginQuery, setPluginQuery] = React.useState("");
  const [pluginCategoryFilter, setPluginCategoryFilter] = React.useState("");
  const [pluginStateFilter, setPluginStateFilter] = React.useState("");
  const [updatePlugin, setUpdatePlugin] = React.useState<any>();
  const [pendingPlugin, setPendingPlugin] = React.useState<{
    id: string;
    enabled: boolean;
  }>();
  const theme = useTheme();
  const { dark } = theme;
  const page = React.useRef<HTMLDivElement>(null);
  const content = React.useRef<HTMLElement>(null);
  const path = hash.split("?")[0];
  const client = React.useMemo(
    () =>
      createClient(
        () => setVersion((v) => v + 1),
        () => {
          setUser(null);
          setPlugins([]);
          location.hash = "/login";
        },
        internationalization,
        confirmIdentity,
      ),
    [],
  );
  const brand = useBranding(client, version, dark);
  React.useEffect(
    () => setSiteLanguage(brand.defaultLanguage),
    [brand.defaultLanguage],
  );
  React.useEffect(
    () =>
      syncLanguagePreferences(
        (language, signal) =>
          client.request(auth + "/preferences", {
            method: "PATCH",
            body: JSON.stringify({ language }),
            signal,
          }),
        () => setMessage(tr("语言偏好保存失败，请重试。")),
      ),
    [client],
  );
  React.useEffect(() => {
    setAccountLanguage(user?.id, user?.language);
  }, [user?.id]);
  const setupChecked = !!setupState;
  const finishSetup = React.useCallback(() => {
    setSetupState({ required: false, stage: "complete" });
    client.navigate("/login");
    client.refresh();
  }, [client]);
  async function logout() {
    try {
      await client.request(auth + "/logout", { method: "POST" });
      setUser(null);
      setPlugins([]);
      client.navigate("/login");
      setVersion((v) => v + 1);
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  React.useEffect(() => {
    let live = true;
    const load = () =>
      void client
        .request<{ portal: PortalContent }>("/console/public")
        .then((value) => {
          if (live) setPortal(value.portal);
        })
        .catch(() => {})
        .finally(() => {
          if (live) setPublicLoaded(true);
        });
    load();
    window.addEventListener("pluhub:public", load);
    return () => {
      live = false;
      window.removeEventListener("pluhub:public", load);
    };
  }, [client, version]);
  React.useEffect(() => {
    let live = true;
    setSetupError("");
    void client
      .request<SetupState>("/api/host/setup")
      .then((state) => {
        if (live) setSetupState(state);
      })
      .catch((error) => {
        if (live) setSetupError(error.message);
      });
    return () => {
      live = false;
    };
  }, [version, client]);
  React.useEffect(() => {
    if (!loaded || !setupState) return;
    const destination =
      setupRedirect(setupState.required, path, !!user) ??
      (user && ["/login", "/register"].includes(path)
        ? loginDestination(hash)
        : undefined);
    if (destination) client.navigate(destination);
  }, [user, loaded, setupState, path, hash, client]);
  React.useEffect(() => {
    if (!user) return;
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        const overlay = document.querySelector(
          '[role="dialog"], [role="listbox"]',
        );
        if (!overlay || overlay.querySelector(".command-input"))
          setSearchOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [user]);
  React.useEffect(() => {
    let live = true;
    void client
      .request(auth + "/me")
      .then(
        (value) => {
          if (live) setUser(value);
        },
        () => {
          if (live) setUser(null);
        },
      )
      .finally(() => {
        if (live) setLoaded(true);
      });
    void client
      .request<Extension[]>("/api/host/extensions")
      .then((value) => {
        if (live) setExtensions(value);
      })
      .catch((e) => {
        if (live) setMessage(e.message);
      })
      .finally(() => {
        if (live) setExtensionsLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [version]);
  React.useEffect(() => {
    const change = () => {
      setHash(location.hash.slice(1) || "/");
      window.scrollTo(0, 0);
      setMobile(false);
      setMessage("");
    };
    addEventListener("hashchange", change);
    return () => removeEventListener("hashchange", change);
  }, []);
  const admin = user?.role === "admin";
  React.useEffect(() => {
    if (path === "/admin/activity") {
      client.navigate(hash.replace("/admin/activity", "/activity"));
      return;
    }
    const destination = channelSettingsDestination(path!);
    if (admin && destination && extensions.some((e) => e.path === "/channels"))
      client.navigate(destination);
  }, [admin, hash, path, client, extensions]);
  const modelCatalog = extensions.find(
    (e) =>
      e.id === "official.model-catalog" && e.path === "/models" && e.public,
  );
  const {
    sections,
    selected,
    section,
    personal,
    management,
    managementMode,
    searchEntries,
    paymentAdapters,
    verificationProviders,
  } = navigation(
    extensions.map((entry) =>
      entry.id.startsWith("official.")
        ? { ...entry, title: tr(entry.title) }
        : entry,
    ),
    admin,
    path,
  );
  React.useEffect(() => {
    if (admin && path === "/plugins")
      void client
        .request<any[]>("/api/host/plugins")
        .then(setPlugins)
        .catch((e) => setMessage(e.message));
  }, [admin, path, version, client]);
  usePageTransition(
    path + ":" + (new URLSearchParams(hash.split("?")[1]).get("tab") ?? ""),
    loaded && publicLoaded && setupChecked && !!setupState,
    content,
    page,
  );
  React.useEffect(() => {
    let dispose: (() => void) | undefined;
    let canceled = false;
    if (
      loaded &&
      publicLoaded &&
      user &&
      setupChecked &&
      !setupState?.required &&
      selected &&
      !!selected.url &&
      page.current
    ) {
      const el = page.current;
      void import(selected.url)
        .then((mod: UIExtensionModule) => {
          if (!canceled)
            dispose = mod.mount(el, {
              ...client,
              page: selected.path,
              authenticated: true,
            });
        })
        .catch((e) => {
          if (!canceled) setMessage(tr("页面加载失败：") + e.message);
        });
    }
    return () => {
      canceled = true;
      dispose?.();
    };
  }, [
    selected?.id,
    selected?.url,
    loaded,
    publicLoaded,
    user,
    hash,
    version,
    setupChecked,
    setupState?.required,
  ]);
  if (
    !loaded ||
    !publicLoaded ||
    (!user && path === "/models" && !extensionsLoaded) ||
    !setupState ||
    setupError ||
    setupRedirect(setupState.required, path, !!user)
  )
    return (
      <main className="loading">
        {setupError ? (
          <div role="alert">
            {tr("无法检查初始化状态：")}
            {setupError}
            <button onClick={() => client.refresh()}>{tr("重试")}</button>
          </div>
        ) : (
          tr("正在连接你的网关…")
        )}
      </main>
    );
  if (setupState.required)
    return (
      <div className="setup-layout">
        <header className="setup-header">
          <span className="brand">
            <BrandMark brand={brand} />
            <span className="brand-name">{brand.name}</span>
          </span>
          <div className="actions">
            <button
              className="ghost"
              aria-label={dark ? tr("切换为浅色模式") : tr("切换为深色模式")}
              onClick={theme.toggle}
            >
              <Icon name={dark ? "sun" : "moon"} />
            </button>
          </div>
        </header>
        <main ref={content}>
          <Onboarding
            host={client}
            initial={setupState}
            onComplete={finishSetup}
          />
        </main>
        {brand.footerText && <footer>{brand.footerText}</footer>}
      </div>
    );
  if (
    (!user && path === "/models") ||
    (portal.enabled && (path === "/" || path.startsWith("/public/")))
  )
    return (
      <Portal
        brand={brand}
        content={portal}
        path={path}
        user={user}
        theme={theme}
        modelCatalog={!!modelCatalog}
        contentRef={content}
      >
        {!user && path === "/models" ? (
          modelCatalog ? (
            <PublicExtension
              key={version}
              extension={modelCatalog}
              client={client}
              containerRef={page}
            />
          ) : (
            <Empty title={tr("模型目录暂不可用")}>
              <a
                className="button secondary"
                href={portal.enabled ? "#/" : "#/login"}
              >
                {tr("返回{0}", {
                  "0": textValue(portal.enabled ? tr("首页") : tr("登录")),
                })}
              </a>
            </Empty>
          )
        ) : undefined}
      </Portal>
    );
  if (!user)
    return (
      <div className="auth-shell">
        <header className="auth-header">
          <a className="brand" href={portal.enabled ? "#/" : "#/login"}>
            <BrandMark brand={brand} />
            <span className="brand-name">{brand.name}</span>
          </a>
          <nav className="auth-navigation" aria-label={tr("公开导航")}>
            <LanguageMenu />
            {modelCatalog && (
              <a className="auth-home" href="#/models">
                {tr("查看模型")}
              </a>
            )}
          </nav>
        </header>
        <div
          className={
            "login-layout" +
            (!brand.loginTitle && !brand.loginDescription
              ? " login-compact"
              : "")
          }
        >
          {(brand.loginTitle || brand.loginDescription) && (
            <section className="login-story">
              <div>
                {brand.loginTitle && (
                  <h1 className="brand-login-title">{brand.loginTitle}</h1>
                )}
                {brand.loginDescription && <p>{brand.loginDescription}</p>}
              </div>
            </section>
          )}
          <div className="login-panel">
            <div
              className="login-content"
              ref={(element) => {
                content.current = element;
              }}
            >
              <Login
                key={path === "/register" ? "register" : "login"}
                register={path === "/register"}
                client={client}
                siteName={brand.name}
                done={() => {
                  client.navigate(loginDestination(hash));
                  setVersion((v) => v + 1);
                }}
              />
              <BrandLinks brand={brand} />
            </div>
          </div>
        </div>
        {brand.footerText && (
          <footer className="auth-footer">{brand.footerText}</footer>
        )}
      </div>
    );
  const nav = (items: Extension[]) =>
    items.map((e) => (
      <a
        key={e.id}
        href={"#" + e.path}
        className={
          path === e.path ||
          (consoleNav.walletActive &&
            consoleNav.wallet.some((item) => item.path === e.path))
            ? "active"
            : ""
        }
        aria-current={
          path === e.path ||
          (consoleNav.walletActive &&
            consoleNav.wallet.some((item) => item.path === e.path))
            ? "page"
            : undefined
        }
      >
        <Icon name={pageIcons[e.path] ?? "plugins"} />
        {e.title}
      </a>
    ));
  const consoleNav = consoleNavigation(personal, path);
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
  async function state(id: string, enabled: boolean) {
    setBusy(true);
    try {
      await client.request("/api/host/plugin-state", {
        method: "POST",
        body: JSON.stringify({ id, enabled }),
      });
      setVersion((v) => v + 1);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="layout">
      {mobile && (
        <button
          className="sidebar-scrim"
          aria-label={tr("关闭导航")}
          onClick={() => setMobile(false)}
        />
      )}
      <aside className={mobile ? "open" : ""}>
        <a className="brand" href={managementMode ? "#/admin" : "#/console"}>
          <BrandMark brand={brand} />
          <span className="brand-name" title={brand.name}>
            {brand.name}
          </span>
        </a>
        {managementMode ? (
          <SettingsNavigation
            sections={sections}
            selectedPath={selected?.path}
            home={path === "/settings"}
            management={management}
            overview={path === "/admin"}
          />
        ) : (
          <>
            <nav aria-label={tr("主导航")}>
              <span className="nav-label">{tr("模型服务")}</span>
              <a
                href="#/console"
                className={path === "/console" ? "active" : ""}
                aria-current={path === "/console" ? "page" : undefined}
              >
                <Icon name="overview" />
                {tr("总览")}
              </a>
              {nav(consoleNav.tools)}
              {consoleNav.account.length > 0 && (
                <>
                  <span className="nav-label">{tr("我的账号")}</span>
                  {nav(consoleNav.account)}
                </>
              )}
              {consoleNav.other.length > 0 && (
                <>
                  <span className="nav-label">{tr("扩展")}</span>
                  {nav(consoleNav.other)}
                </>
              )}
              {admin && (
                <a href="#/admin">
                  <Icon name="settings" />
                  {tr("管理后台")}
                </a>
              )}
            </nav>
          </>
        )}
        <Slot name="sidebar.footer" client={client} version={version} />
        <div className="sidebar-bottom">
          <AccountMenu
            host={client}
            user={user}
            extensions={extensions}
            mode={theme.mode}
            change={theme.change}
            logout={logout}
            path={path!}
          />
        </div>
      </aside>
      <section className="main">
        <header>
          <div className="breadcrumb">
            <button
              className="ghost icon-button mobile-menu"
              aria-label={tr("打开导航")}
              onClick={() => setMobile(true)}
            >
              <Icon name="menu" />
            </button>
            {managementMode ? (
              <a href="#/admin">{tr("管理后台")}</a>
            ) : (
              <a href="#/console">{tr("控制台")}</a>
            )}
            <span>/</span>
            <strong>
              {path === "/admin" && admin
                ? tr("全站总览")
                : path === "/settings" && admin
                  ? tr("设置总览")
                  : (selected?.title ??
                    section?.title ??
                    (path === "/plugins"
                      ? tr("插件管理")
                      : path === "/console"
                        ? tr("总览")
                        : tr("页面不可用")))}
            </strong>
          </div>
          <div className="actions">
            <LanguageMenu />
            <button
              className="header-search"
              aria-label={tr("打开页面搜索")}
              onClick={() => setSearchOpen(true)}
            >
              <Icon name="search" size={16} />
              <span>{tr("搜索")}</span>
              <kbd>Ctrl K</kbd>
            </button>
          </div>
        </header>
        <main ref={content}>
          {consoleNav.walletActive && consoleNav.wallet.length > 1 && (
            <nav className="wallet-tabs" aria-label={tr("钱包功能")}>
              {consoleNav.wallet.map((entry) => (
                <a
                  key={entry.id}
                  href={"#" + entry.path}
                  className={path === entry.path ? "active" : ""}
                  aria-current={path === entry.path ? "page" : undefined}
                >
                  {entry.path === "/billing"
                    ? tr("余额与账单")
                    : tr("充值与订阅")}
                </a>
              ))}
            </nav>
          )}
          {message && (
            <div className="notice" role="alert">
              {message}
              <button className="ghost" onClick={() => setMessage("")}>
                {tr("关闭")}
              </button>
            </div>
          )}
          {path === "/console" ||
          path === "/login" ||
          path === "/register" ||
          path === "/" ? (
            <>
              <Slot name="dashboard.top" client={client} version={version} />
              <Dashboard key={version} client={client} management={false} />
            </>
          ) : path === "/admin" && admin ? (
            <Dashboard key={version} client={client} management />
          ) : path === "/settings" && admin ? (
            <SettingsHome sections={sections} />
          ) : selected?.path === "/audit" && admin ? (
            <AuditPage client={client} />
          ) : selected?.path === "/logs" && admin ? (
            <RuntimeLogs key={hash} client={client} />
          ) : selected?.path === "/status" && admin ? (
            <SystemStatus client={client} />
          ) : selected?.path === "/plugins" && admin ? (
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
                <button
                  className="secondary"
                  onClick={() => setVersion((v) => v + 1)}
                >
                  <Icon name="refresh" size={16} />
                  {tr("刷新")}
                </button>
              </PageHeading>
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
                              ? tr(
                                  p.description || p.manifest.description || "",
                                )
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
                              "badge " +
                              (p.codeReload === "parallel" ? "ready" : "")
                            }
                          >
                            {p.codeReload === "parallel"
                              ? tr("可热更新")
                              : tr("重启应用")}
                          </span>
                        </td>
                        <td>
                          {
                            <button
                              className="ghost"
                              disabled={busy}
                              onClick={() => setUpdatePlugin(p)}
                            >
                              {tr("更新")}
                            </button>
                          }
                          <button
                            className="ghost"
                            disabled={
                              busy ||
                              (p.state === "Active" && p.managementProtected)
                            }
                            title={
                              p.managementProtected
                                ? tr(
                                    "该组件提供管理入口，请通过本地维护流程停用",
                                  )
                                : undefined
                            }
                            onClick={() =>
                              setPendingPlugin({
                                id: p.id,
                                enabled: p.state !== "Active",
                              })
                            }
                          >
                            {p.state === "Active" && p.managementProtected
                              ? tr("管理入口")
                              : p.state === "Active"
                                ? tr("停用")
                                : tr("启用")}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {plugins.length > 0 && visiblePlugins.length === 0 && (
                <Empty title={tr("没有匹配的插件")} />
              )}
            </>
          ) : (
            <React.Fragment
              key={
                selected?.path === verificationPath ? verificationPath : hash
              }
            >
              {section && (
                <PageHeading title={selected?.title ?? section.title} />
              )}
              {selected?.path === verificationPath ? (
                <div className="settings-content">
                  <VerificationSettings
                    client={client}
                    providers={verificationProviders}
                    hash={hash}
                  />
                </div>
              ) : selected?.path === paymentMethodsPath ? (
                <div className="settings-content">
                  <PaymentMethods
                    adapters={paymentAdapters}
                    hash={hash}
                    client={client}
                    version={version}
                  />
                </div>
              ) : (
                <div
                  ref={page}
                  key={selected?.id ?? "missing"}
                  className={section ? "settings-content" : undefined}
                >
                  {!selected && (
                    <Empty title={tr("该扩展未启用或不存在")}>
                      <a className="button secondary" href="#/console">
                        {tr("返回总览")}
                      </a>
                    </Empty>
                  )}
                </div>
              )}
            </React.Fragment>
          )}
        </main>
        {(brand.websiteUrl ||
          brand.supportEmail ||
          brand.termsUrl ||
          brand.privacyUrl) && (
          <footer className="console-links">
            <BrandLinks brand={brand} />
          </footer>
        )}
      </section>
      {searchOpen && (
        <CommandSearch
          entries={searchEntries}
          close={() => setSearchOpen(false)}
        />
      )}
      {confirmingIdentity && (
        <IdentityConfirmation
          client={client}
          complete={() => finishIdentity()}
          close={() => finishIdentity(new Error(tr("操作已取消")))}
        />
      )}
      {pendingPlugin && (
        <Dialog
          title={pendingPlugin.enabled ? tr("启用插件") : tr("停用插件")}
          close={() => {
            if (!busy) setPendingPlugin(undefined);
          }}
        >
          <p>
            {pendingPlugin.enabled ? tr("确认启用") : tr("确认停用")}「
            {plugins.find((p) => p.id === pendingPlugin.id)?.name ||
              pendingPlugin.id}
            」？
            {!pendingPlugin.enabled &&
              tr("该插件的页面和能力将不可用，依赖它的功能也可能受影响。")}
          </p>
          <div className="form-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setPendingPlugin(undefined)}
            >
              {tr("取消")}
            </button>
            <button
              className={pendingPlugin.enabled ? "" : "danger"}
              disabled={busy}
              onClick={async () => {
                await state(pendingPlugin.id, pendingPlugin.enabled);
                setPendingPlugin(undefined);
              }}
            >
              {busy ? tr("处理中…") : tr("确认")}
            </button>
          </div>
        </Dialog>
      )}
      {updatePlugin && (
        <RegistryBrowser
          client={client}
          installed={plugins}
          focusId={updatePlugin.id}
          close={() => setUpdatePlugin(undefined)}
          done={() => {
            setUpdatePlugin(undefined);
            setVersion((v) => v + 1);
            setMessage(tr("插件已更新"));
          }}
        />
      )}
    </div>
  );
}
function BrandLinks({ brand }: { brand: import("./branding.js").Branding }) {
  return (
    <div className="brand-links">
      {brand.websiteUrl && (
        <a href={brand.websiteUrl} target="_blank" rel="noopener noreferrer">
          {tr("官方网站")}
        </a>
      )}
      {brand.supportEmail && (
        <a href={"mailto:" + encodeURIComponent(brand.supportEmail)}>
          {tr("联系支持")}
        </a>
      )}
      {brand.termsUrl && (
        <a href={brand.termsUrl} target="_blank" rel="noopener noreferrer">
          {tr("服务条款")}
        </a>
      )}
      {brand.privacyUrl && (
        <a href={brand.privacyUrl} target="_blank" rel="noopener noreferrer">
          {tr("隐私政策")}
        </a>
      )}
    </div>
  );
}
export function mount(element: HTMLElement, host?: UIHost) {
  configureMessages({ "en-US": en });
  if (!host?.page) initializeLanguage(getLocale());
  const root = createRoot(element);
  function LocalizedRoot() {
    useLocale();
    return host?.page === "/settings/branding" ? (
      <BrandingSettings host={host} />
    ) : host?.page === "/settings/portal" ? (
      <PortalSettings host={host} />
    ) : (
      <App />
    );
  }
  root.render(<LocalizedRoot />);
  return () => root.unmount();
}
