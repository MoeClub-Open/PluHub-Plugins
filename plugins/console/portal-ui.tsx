import { Checkbox } from "../../lib/ui/checkbox.js";
import { t as tr, textValue } from "../../lib/ui/i18n.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { BrandMark } from "./branding-ui.js";
import type { Branding } from "./branding.js";
import { defaultPortal, readPortal, type PortalContent } from "./portal.js";
import { consoleEntry } from "./onboarding.js";
import { Notice, useLoad } from "../../lib/ui/mount.js";
import { Empty, Icon } from "../../lib/ui/components.js";
import type { ThemeMode } from "./theme.js";
import { LanguageMenu } from "./language-menu.js";

export function Portal({
  brand,
  content,
  path,
  user,
  theme,
  modelCatalog = false,
  children,
  contentRef,
}: {
  brand: Branding;
  content: PortalContent;
  path: string;
  user?: any;
  theme: { mode: ThemeMode; change: (mode: ThemeMode) => void };
  modelCatalog?: boolean;
  children?: React.ReactNode;
  contentRef?: React.Ref<HTMLElement>;
}) {
  const [copyStatus, setCopyStatus] = React.useState("");
  const [exampleOpen, setExampleOpen] = React.useState(
    () => window.matchMedia("(min-width: 701px)").matches,
  );
  const exampleId = React.useId();
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
    <div className="portal-shell">
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
                  "portal-intro" +
                  (content.showEndpoint ? "" : " portal-intro-text")
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
                {content.showEndpoint && (
                  <section className="portal-api" aria-label={tr("API 接入")}>
                    <div className="portal-api-heading">
                      <h2>{tr("API 接入")}</h2>
                      <button
                        className="ghost portal-example-toggle"
                        aria-expanded={exampleOpen}
                        aria-controls={exampleId}
                        onClick={() => setExampleOpen((open) => !open)}
                      >
                        {tr("调用示例")}
                        <Icon name="chevron" size={14} />
                      </button>
                    </div>
                    <div className="portal-api-row">
                      <div className="portal-api-address">
                        <span>{tr("API 地址")}</span>
                        <code title={endpoint}>{endpoint}</code>
                      </div>
                      <div className="portal-api-actions">
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
                          <Icon
                            name={
                              copyStatus === tr("已复制") ? "check" : "copy"
                            }
                            size={14}
                          />
                          <span role="status">{copyStatus || tr("复制")}</span>
                        </button>
                      </div>
                    </div>
                    {exampleOpen && (
                      <div
                        className="portal-example"
                        id={exampleId}
                        role="region"
                        aria-label={tr("调用示例")}
                      >
                        <div className="portal-code-language">cURL</div>
                        <pre>
                          <code>{`curl ${endpoint}/chat/completions \\\n  -H "Authorization: Bearer $API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "YOUR_MODEL",\n    "messages": [{"role": "user", "content": "Hello"}]\n  }'`}</code>
                        </pre>
                      </div>
                    )}
                  </section>
                )}
              </div>
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

export function PortalSettings({ host }: { host: UIHost }) {
  const data = useLoad<any>(() => host.request("/api/host/config"));
  const [draft, setDraft] = React.useState(defaultPortal);
  const [saved, setSaved] = React.useState(defaultPortal);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  React.useEffect(() => {
    if (data.data) {
      const value = readPortal(consoleEntry(data.data)?.config ?? {});
      setDraft(value);
      setSaved(value);
    }
  }, [data.data]);
  const set = <K extends keyof PortalContent>(
    key: K,
    value: PortalContent[K],
  ) => {
    setDraft((old) => ({ ...old, [key]: value }));
    setMessage("");
  };
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const portal = readPortal({ portal: draft });
      const config = await host.request<any>("/api/host/config");
      const entry = consoleEntry(config);
      if (!entry) throw new Error(tr("控制台插件不存在"));
      entry.config = { ...entry.config, portal };
      await host.request("/api/host/config", {
        method: "PUT",
        body: JSON.stringify(config),
      });
      setDraft(portal);
      setSaved(portal);
      setMessage(tr("门户与公开内容已保存并发布。"));
      window.dispatchEvent(new Event("pluhub:public"));
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const field = (
    key:
      | "eyebrow"
      | "title"
      | "description"
      | "announcement"
      | "primaryLabel"
      | "primaryUrl"
      | "docsUrl",
    title: string,
    multiline = false,
  ) => (
    <label>
      {title}
      {multiline ? (
        <textarea
          rows={3}
          value={draft[key]}
          onChange={(event) => set(key, event.target.value)}
        />
      ) : (
        <input
          value={draft[key]}
          onChange={(event) => set(key, event.target.value)}
        />
      )}
    </label>
  );
  function collection(
    key: "features" | "faqs" | "pages",
    title: string,
    fields: Record<string, string>,
    maximum: number,
  ) {
    const items = draft[key] as unknown as Record<string, string>[];
    return (
      <section className="card settings-form-section">
        <div className="panel-heading">
          <div>
            <h2>{title}</h2>
            <span className="muted">
              {tr("{0}/{1} 项", {
                "0": textValue(items.length),
                "1": textValue(maximum),
              })}
            </span>
          </div>
          <button
            type="button"
            className="secondary"
            disabled={items.length >= maximum}
            onClick={() =>
              set(key, [
                ...items,
                Object.fromEntries(
                  Object.keys(fields).map((name) => [name, ""]),
                ),
              ] as any)
            }
          >
            <Icon name="plus" size={15} />
            {tr("添加")}
          </button>
        </div>
        {items.map((item, index) => (
          <fieldset className="portal-editor-item" key={index}>
            <legend>
              {title} {index + 1}
            </legend>
            <div className="actions">
              <button
                type="button"
                className="ghost"
                disabled={index === 0}
                onClick={() => {
                  const next = [...items];
                  [next[index - 1], next[index]] = [
                    next[index],
                    next[index - 1],
                  ];
                  set(key, next as any);
                }}
              >
                {tr("上移")}
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() =>
                  set(key, items.filter((_, n) => n !== index) as any)
                }
              >
                {tr("删除")}
              </button>
            </div>
            {Object.entries(fields).map(([name, label]) => (
              <label key={name}>
                {label}
                {["description", "answer", "body"].includes(name) ? (
                  <textarea
                    rows={name === "body" ? 7 : 3}
                    value={item[name]}
                    onChange={(event) =>
                      set(
                        key,
                        items.map((value, n) =>
                          n === index
                            ? { ...value, [name]: event.target.value }
                            : value,
                        ) as any,
                      )
                    }
                  />
                ) : (
                  <input
                    value={item[name]}
                    onChange={(event) =>
                      set(
                        key,
                        items.map((value, n) =>
                          n === index
                            ? { ...value, [name]: event.target.value }
                            : value,
                        ) as any,
                      )
                    }
                  />
                )}
              </label>
            ))}
          </fieldset>
        ))}
      </section>
    );
  }
  return (
    <>
      <Notice message={message || data.error} />
      {data.data && (
        <form onSubmit={save} className="portal-settings-form">
          <section className="card settings-form-section">
            <div className="panel-heading">
              <div>
                <h2>{tr("门户与首屏")}</h2>
              </div>
              <a
                href="/#/"
                target="_blank"
                rel="noopener noreferrer"
                className="button secondary"
              >
                {tr("查看公开页")}
                <Icon name="arrow" size={14} />
              </a>
            </div>
            <label className="checkbox">
              <Checkbox
                appearance="switch"
                checked={draft.enabled}
                onCheckedChange={(event) => set("enabled", event === true)}
              />
              {tr("启用落地门户页")}
            </label>
            <div className="form-grid">
              {field("eyebrow", tr("首屏标语"))}
              {field("title", tr("门户标题"), true)}
              {field("description", tr("门户简介"), true)}
              {field("announcement", tr("站点公告"), true)}
              {field("primaryLabel", tr("主按钮文字"))}
              {field("primaryUrl", tr("主按钮链接"))}
              {field("docsUrl", tr("文档链接（可留空）"))}
            </div>
            <label className="checkbox">
              <Checkbox
                appearance="switch"
                checked={draft.showEndpoint}
                onCheckedChange={(event) => set("showEndpoint", event === true)}
              />
              {tr("显示 API 接入区")}
            </label>
          </section>
          {collection(
            "features",
            tr("能力介绍"),
            { title: tr("标题"), description: tr("说明") },
            6,
          )}
          {collection(
            "faqs",
            tr("常见问题"),
            { question: tr("问题"), answer: tr("回答") },
            8,
          )}
          {collection(
            "pages",
            tr("公开页面"),
            {
              slug: tr("页面标识"),
              title: tr("页面标题"),
              body: tr("正文（纯文本）"),
            },
            8,
          )}
          <div className="settings-save-bar">
            <span className="muted">
              {JSON.stringify(draft) === JSON.stringify(saved)
                ? tr("已保存")
                : tr("有未保存的修改")}
            </span>
            <div className="actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setDraft(saved)}
              >
                {tr("放弃更改")}
              </button>
              <button disabled={busy}>
                {busy ? tr("正在保存…") : tr("保存并发布")}
              </button>
            </div>
          </div>
        </form>
      )}
    </>
  );
}
