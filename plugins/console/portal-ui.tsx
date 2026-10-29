import { t as tr } from "../../lib/ui/i18n.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { BrandMark } from "./branding-ui.js";
import type { Branding } from "./branding.js";
import { localizePortal, type PortalContent } from "./portal.js";
import { useLocale } from "../../lib/ui/language.js";
import { PortalModels } from "./portal-models.js";
import { Empty, Icon } from "../../lib/ui/components.js";
import type { ThemeMode } from "./theme.js";
import { LanguageMenu } from "./language-menu.js";

export function Portal({
  host,
  brand,
  content: source,
  path,
  user,
  theme,
  modelCatalog = false,
  children,
  contentRef,
}: {
  host: UIHost;
  brand: Branding;
  content: PortalContent;
  path: string;
  user?: any;
  theme: { mode: ThemeMode; change: (mode: ThemeMode) => void };
  modelCatalog?: boolean;
  children?: React.ReactNode;
  contentRef?: React.Ref<HTMLElement>;
}) {
  const locale = useLocale();
  const content = localizePortal(source, locale, brand.defaultLanguage);
  React.useEffect(() => {
    const description = document.querySelector<HTMLMetaElement>(
      'meta[name="description"]',
    );
    if (description)
      description.content = content.description || brand.description;
  }, [content.description, brand.description]);
  const [copyStatus, setCopyStatus] = React.useState("");
  const endpoint = location.origin + "/v1";
  const themeNames = {
    system: tr("跟随系统"),
    light: tr("浅色"),
    dark: tr("深色"),
  };
  const nextTheme =
    theme.mode === "system"
      ? "light"
      : theme.mode === "light"
        ? "dark"
        : "system";
  React.useEffect(() => {
    if (!copyStatus) return;
    const timer = setTimeout(() => setCopyStatus(""), 3000);
    return () => clearTimeout(timer);
  }, [copyStatus]);
  const slug = path.startsWith("/public/") ? path.slice(8) : undefined;
  const page = content.pages.find((item) => item.slug === slug);
  const hasFooterLinks = !!(
    content.pages.length ||
    brand.supportEmail ||
    brand.termsUrl ||
    brand.privacyUrl
  );
  return (
    <div className={"portal-shell portal-layout-" + content.layout}>
      <header className="portal-header">
        <a className="brand" href="#/">
          <BrandMark brand={brand} />
          <span className="brand-name">{brand.name}</span>
        </a>
        <nav aria-label={tr("门户导航")}>
          {children && content.enabled && <a href="#/">{tr("首页")}</a>}
          {modelCatalog && (
            <a
              href="#/models"
              aria-current={path === "/models" ? "page" : undefined}
            >
              {tr("模型")}
            </a>
          )}
          {content.docsUrl && <a href={content.docsUrl}>{tr("文档")}</a>}
          {user ? (
            <a
              className="portal-account-link"
              href="#/console"
              aria-label={tr("打开控制台：") + user.username}
            >
              <Icon name="users" size={16} />
              <span>{user.username}</span>
            </a>
          ) : (
            <a className="portal-sign-in" href="#/login">
              {tr("登录")}
            </a>
          )}
        </nav>
      </header>
      <main className="portal-main" ref={contentRef}>
        {children ??
          (slug ? (
            page ? (
              <article className="public-article">
                <a href="#/" className="text-link">
                  {tr("← 返回首页")}
                </a>
                <h1>{page.title}</h1>
                <div className="public-prose">{page.body}</div>
              </article>
            ) : (
              <Empty title={tr("页面不存在或尚未发布")}>
                <a className="button secondary" href="#/">
                  {tr("返回首页")}
                </a>
              </Empty>
            )
          ) : (
            <>
              {content.announcement && (
                <div className="portal-announcement" role="note">
                  <Icon name="activity" size={16} />
                  {content.announcement}
                </div>
              )}
              <div
                className={
                  "portal-intro" + (modelCatalog ? "" : " portal-intro-text")
                }
              >
                <section className="portal-hero">
                  {content.eyebrow && (
                    <p className="portal-kicker">{content.eyebrow}</p>
                  )}
                  <h1>{content.title}</h1>
                  {content.description && (
                    <p className="portal-description">{content.description}</p>
                  )}
                  <div className="portal-actions">
                    <a className="button" href={content.primaryUrl}>
                      {content.primaryLabel}
                      <Icon name="arrow" size={16} />
                    </a>
                    {!user && content.primaryUrl !== "#/register" && (
                      <a className="portal-secondary" href="#/register">
                        {tr("创建账号")}
                      </a>
                    )}
                  </div>
                </section>
                {modelCatalog && (
                  <PortalModels host={host} selected={content.featuredModels} />
                )}
              </div>
              {content.showEndpoint && (
                <div className="portal-endpoint">
                  <span>API</span>
                  <code>{endpoint}</code>
                  <button
                    className="ghost"
                    aria-label={tr("复制 API 地址")}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(endpoint);
                        setCopyStatus(tr("已复制"));
                      } catch {
                        setCopyStatus(tr("复制失败，请手动复制"));
                      }
                    }}
                  >
                    <Icon name="copy" size={14} />
                    <span role="status">{copyStatus || tr("复制")}</span>
                  </button>
                </div>
              )}
              {content.features.length > 0 && (
                <section
                  className="portal-features"
                  aria-label={tr("平台能力")}
                >
                  {content.features.map((feature, index) => (
                    <article key={index}>
                      <h2>{feature.title}</h2>
                      <p>{feature.description}</p>
                    </article>
                  ))}
                </section>
              )}
              {content.faqs.length > 0 && (
                <section className="portal-faq" aria-label={tr("常见问题")}>
                  <h2>{tr("常见问题")}</h2>
                  <div>
                    {content.faqs.map((faq, index) => (
                      <details key={index}>
                        <summary>{faq.question}</summary>
                        <p>{faq.answer}</p>
                      </details>
                    ))}
                  </div>
                </section>
              )}
            </>
          ))}
      </main>
      <footer className="portal-footer">
        {brand.footerText && <span>{brand.footerText}</span>}
        {hasFooterLinks && (
          <nav aria-label={tr("公开内容")}>
            {content.pages.map((item) => (
              <a key={item.slug} href={"#/public/" + item.slug}>
                {item.title}
              </a>
            ))}
            {brand.supportEmail && (
              <a href={"mailto:" + brand.supportEmail}>{tr("联系支持")}</a>
            )}
            {brand.termsUrl && <a href={brand.termsUrl}>{tr("服务条款")}</a>}
            {brand.privacyUrl && (
              <a href={brand.privacyUrl}>{tr("隐私政策")}</a>
            )}
          </nav>
        )}
        <div className="portal-utilities">
          <LanguageMenu />
          <button
            className="ghost icon-button portal-theme"
            aria-label={
              tr("颜色模式：") +
              themeNames[theme.mode] +
              tr("，点击切换为") +
              themeNames[nextTheme]
            }
            title={tr("颜色模式：") + themeNames[theme.mode]}
            onClick={() => theme.change(nextTheme)}
          >
            <Icon
              name={
                theme.mode === "system"
                  ? "monitor"
                  : theme.mode === "dark"
                    ? "moon"
                    : "sun"
              }
              size={15}
            />
          </button>
        </div>
      </footer>
    </div>
  );
}
