import React from "react";
import type { UIHost, Extension, UIExtensionModule, Locale } from "@pluhub/ui-sdk";
import { t as tr } from "../../lib/ui/i18n.js";
import { LanguageMenu } from "./language-menu.js";
import { ThemeButton } from "./theme-button.js";
import type { Theme } from "./theme.js";
import { BrandMark } from "./branding-ui.js";
import type { Branding } from "./branding.js";
import { localizePortal, type PortalContent } from "./portal.js";
import { GatewayVisual } from "./gateway-visual.js";
import { Login } from "./login.js";
import { loginDestination } from "./navigation.js";

export function PublicExtension({
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

export function BrandLinks({ brand }: { brand: Branding }) {
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

export function AuthShell({
  brand,
  portal,
  locale,
  path,
  hash,
  theme,
  modelCatalog,
  client,
  contentRef,
  onAuthenticated,
}: {
  brand: Branding;
  portal: PortalContent;
  locale: Locale;
  path: string;
  hash: string;
  theme: Theme;
  modelCatalog: boolean;
  client: UIHost;
  contentRef: React.MutableRefObject<HTMLElement | null>;
  onAuthenticated: () => void;
}) {
  return (
    <div className="auth-shell">
      <header className="auth-header">
        <a className="brand" href={portal.enabled ? "#/" : "#/login"}>
          <BrandMark brand={brand} />
          <span className="brand-name">{brand.name}</span>
        </a>
        <nav className="auth-navigation" aria-label={tr("公开导航")}>
          <LanguageMenu />
          <ThemeButton theme={theme} />
          {modelCatalog && (
            <a className="auth-home" href="#/models">
              {tr("查看模型")}
            </a>
          )}
        </nav>
      </header>
      <div className="login-layout">
        <section className="login-story">
          <div className="login-story-copy">
            <h2 className="brand-login-title">
              {brand.loginTitle ||
                localizePortal(portal, locale, brand.defaultLanguage).title}
            </h2>
            {brand.loginDescription && <p>{brand.loginDescription}</p>}
          </div>
          <GatewayVisual name={brand.name} example={false} />
        </section>
        <div className="login-panel">
          <div
            className="login-content"
            ref={(element) => {
              contentRef.current = element;
            }}
          >
            <Login
              key={path === "/register" ? "register" : "login"}
              register={path === "/register"}
              client={client}
              siteName={brand.name}
              done={() => {
                client.navigate(loginDestination(hash));
                onAuthenticated();
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
}
