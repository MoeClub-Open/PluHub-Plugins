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
import { Dashboard } from "./dashboard.js";
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
import { SettingsNavigation } from "./settings.js";
import { SettingsExtension } from "../../lib/ui/settings-extension.js";
import { BrandMark, BrandingSettings, useBranding } from "./branding-ui.js";
import { CommandSearch } from "./command-search.js";
import { IdentityConfirmation } from "./identity-confirmation.js";
import { Portal } from "./portal-ui.js";
import { PortalSettings } from "./portal-settings.js";
import { ThemeButton } from "./theme-button.js";
import { defaultPortal, type PortalContent } from "./portal.js";
import { Onboarding } from "./onboarding-ui.js";
import { setupRedirect, type SetupState } from "./onboarding.js";
import { Icon, PageHeading, Empty } from "../../lib/ui/components.js";
import { AuthShell, BrandLinks, PublicExtension } from "./auth-shell.js";
import { PluginsPage } from "./plugins-page.js";
import "./tokens.css";
import "./layout.css";
import "./tables.css";
import "./components.css";
import "./management.css";
import "./settings.css";
import "./appearance.css";
import "./portal.css";
import "./auth.css";
import "./controls.css";
import "./choices.css";
import "./interfaces.css";
import "@xyflow/react/dist/style.css";
import "./flow.css";
import "./keys.css";
import "./motion.css";
import { en } from "../../lib/ui/locales/en.js";
import { configureMessages } from "../../lib/ui/i18n.js";

const auth = "/api/plugins/official.auth";

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
  const locale = useLocale();
  const [user, setUser] = React.useState<any>();
  const [loaded, setLoaded] = React.useState(false);
  const [extensions, setExtensions] = React.useState<Extension[]>([]);
  const [extensionsLoaded, setExtensionsLoaded] = React.useState(false);
  const [hash, setHash] = React.useState(location.hash.slice(1) || "/");
  const [portal, setPortal] = React.useState<PortalContent>(defaultPortal);
  const [publicLoaded, setPublicLoaded] = React.useState(false);
  const [setupState, setSetupState] = React.useState<SetupState>();
  const [setupError, setSetupError] = React.useState("");
  const [message, setMessage] = React.useState("");
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
  const theme = useTheme();
  const { dark } = theme;
  const page = React.useRef<HTMLDivElement>(null);
  const content = React.useRef<HTMLElement>(null);
  const path = hash.split("?")[0] ?? "/";
  const client = React.useMemo(
    () =>
      createClient(
        () => setVersion((v) => v + 1),
        () => {
          setUser(null);
          location.hash = "/login";
        },
        internationalization,
        confirmIdentity,
      ),
    [],
  );
  const brand = useBranding(client, version, dark, theme.palette);
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
  }, [user?.id, user?.language]);
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
    if (admin && path === "/settings") {
      client.navigate("/admin");
      return;
    }
    const destination = channelSettingsDestination(path);
    if (
      admin &&
      destination &&
      (destination === "/settings/traffic" ||
        extensions.some((e) => e.path === "/channels"))
    )
      client.navigate(destination);
  }, [admin, path, client, extensions]);
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
  usePageTransition(
    path + ":" + (new URLSearchParams(hash.split("?")[1]).get("tab") ?? ""),
    loaded && publicLoaded && setupChecked && !!setupState,
    content,
    page,
  );
  const mountKey = selected?.path === "/commerce" ? "/commerce" : hash;
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
    mountKey,
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
            <ThemeButton theme={theme} />
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
        host={client}
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
      <AuthShell
        brand={brand}
        portal={portal}
        locale={locale}
        path={path}
        hash={hash}
        theme={theme}
        modelCatalog={!!modelCatalog}
        client={client}
        contentRef={content}
        onAuthenticated={() => setVersion((v) => v + 1)}
      />
    );
  const consoleNav = consoleNavigation(personal, path);
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
  const hashParams = new URLSearchParams(hash.split("?")[1]);
  const commerceTab =
    hashParams.get("tab") ?? (hashParams.has("order") ? "orders" : "plans");
  const walletTabs = [
    ...(consoleNav.wallet.some((e) => e.path === "/billing")
      ? [
          {
            key: "billing",
            href: "#/billing",
            label: tr("账单明细"),
            active: path === "/billing",
          },
        ]
      : []),
    ...(consoleNav.wallet.some((e) => e.path === "/commerce")
      ? [
          {
            key: "plans",
            href: "#/commerce",
            label: tr("充值购买"),
            active: path === "/commerce" && commerceTab === "plans",
          },
          {
            key: "subscriptions",
            href: "#/commerce?tab=subscriptions",
            label: tr("我的订阅"),
            active: path === "/commerce" && commerceTab === "subscriptions",
          },
          {
            key: "orders",
            href: "#/commerce?tab=orders",
            label: tr("订单历史"),
            active: path === "/commerce" && commerceTab === "orders",
          },
        ]
      : []),
  ];
  return (
    <div className="layout">
      {mobile && (
        <button
          className="sidebar-scrim"
          aria-label={tr("关闭导航")}
          onClick={() => setMobile(false)}
        />
      )}
      <aside id="console-sidebar" className={mobile ? "open" : ""}>
        <a className="brand" href={managementMode ? "#/admin" : "#/console"}>
          <BrandMark brand={brand} />
          <span className="brand-name" title={brand.name}>
            {brand.name}
          </span>
        </a>
        <button
          className="sidebar-search"
          aria-label={tr("打开页面搜索")}
          onClick={() => setSearchOpen(true)}
        >
          <Icon name="search" size={16} />
          <span>{tr("搜索")}</span>
          <kbd>Ctrl K</kbd>
        </button>
        {managementMode ? (
          <SettingsNavigation
            sections={sections}
            selectedPath={selected?.path}
            management={management}
            overview={path === "/admin"}
          />
        ) : (
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
        )}
        <Slot name="sidebar.footer" client={client} version={version} />
        <div className="sidebar-bottom">
          <AccountMenu
            host={client}
            user={user}
            extensions={extensions}
            theme={theme}
            logout={logout}
            path={path}
          />
        </div>
      </aside>
      <section className="main">
        <main ref={content}>
          <button
            className="ghost icon-button mobile-menu"
            aria-label={tr("打开导航")}
            aria-controls="console-sidebar"
            aria-expanded={mobile}
            onClick={() => setMobile(true)}
          >
            <Icon name="menu" />
          </button>
          {consoleNav.walletActive && walletTabs.length > 1 && (
            <nav className="wallet-tabs" aria-label={tr("钱包功能")}>
              {walletTabs.map((entry) => (
                <a
                  key={entry.key}
                  href={entry.href}
                  className={entry.active ? "active" : ""}
                  aria-current={entry.active ? "page" : undefined}
                >
                  {entry.label}
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
          ) : (path === "/admin" || path === "/settings") && admin ? (
            <Dashboard key={version} client={client} management />
          ) : selected?.path === "/audit" && admin ? (
            <AuditPage client={client} />
          ) : selected?.path === "/logs" && admin ? (
            <RuntimeLogs key={hash} client={client} />
          ) : selected?.path === "/status" && admin ? (
            <SystemStatus client={client} />
          ) : selected?.path === "/plugins" && admin ? (
            <PluginsPage
              client={client}
              version={version}
              onRefresh={() => setVersion((v) => v + 1)}
              onMessage={setMessage}
            />
          ) : (
            <React.Fragment
              key={
                selected?.path === verificationPath
                  ? verificationPath
                  : mountKey
              }
            >
              {section &&
                !selected?.url &&
                selected?.path !== paymentMethodsPath && (
                  <PageHeading title={selected?.title ?? section.title} />
                )}
              {selected?.path === "/settings/traffic" ? (
                <div className="settings-content">
                  {["/rate-limit", "/token-speed"]
                    .filter((target) =>
                      extensions.some((entry) => entry.path === target),
                    )
                    .map((target) => (
                      <SettingsExtension
                        key={target}
                        host={client}
                        path={target}
                        slot="settings"
                      />
                    ))}
                </div>
              ) : selected?.path === verificationPath ? (
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
      <>
        <PageHeading title={tr("品牌与外观")} />
        <BrandingSettings host={host} />
      </>
    ) : host?.page === "/settings/portal" ? (
      <>
        <PageHeading title={tr("门户与公开内容")} />
        <PortalSettings host={host} />
      </>
    ) : (
      <App />
    );
  }
  root.render(<LocalizedRoot />);
  return () => root.unmount();
}
