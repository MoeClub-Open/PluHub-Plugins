import { t as tr } from "../../lib/ui/i18n.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { Notice, useLoad } from "../../lib/ui/mount.js";
import { Icon } from "../../lib/ui/components.js";
import { Select } from "../../lib/ui/select.js";
import type { Locale } from "@pluhub/ui-sdk";
import {
  defaultBranding,
  readBranding,
  brandColors,
  brandingLimits,
  type Branding,
} from "./branding.js";

export function BrandMark({ brand }: { brand: Branding }) {
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => setFailed(false), [brand.logoUrl]);
  return brand.logoUrl && !failed ? (
    <img
      className="brand-logo"
      src={brand.logoUrl}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  ) : null;
}

export function useBranding(client: UIHost, version: number, dark: boolean) {
  const [brand, setBrand] = React.useState(() => {
    try {
      const data = document.getElementById("pluhub-branding")?.textContent;
      return data
        ? readBranding({ branding: JSON.parse(data) })
        : defaultBranding;
    } catch {
      return defaultBranding;
    }
  });
  React.useEffect(() => {
    let gone = false,
      revision = 0;
    const load = () => {
      const current = ++revision;
      void client
        .request<Branding>("/console/branding")
        .then((value) => {
          if (!gone && revision === current)
            setBrand(readBranding({ branding: value }));
        })
        .catch(() => {});
    };
    load();
    window.addEventListener("pluhub:branding", load);
    return () => {
      gone = true;
      window.removeEventListener("pluhub:branding", load);
    };
  }, [client, version]);
  React.useEffect(() => {
    document.title = brand.name;
    const colors = brandColors(brand.accentColor, dark);
    document.documentElement.style.setProperty("--accent", colors.accent);
    document.documentElement.style.setProperty("--accent-soft", colors.soft);
    document.documentElement.style.setProperty("--accent-contrast", colors.ink);
    const icon =
      document.querySelector<HTMLLinkElement>('link[rel="icon"]') ??
      document.head.appendChild(document.createElement("link"));
    icon.rel = "icon";
    icon.href = brand.faviconUrl || "/favicon.ico";
  }, [brand, dark]);
  return brand;
}

export function BrandingSettings({ host }: { host: UIHost }) {
  const data = useLoad<any>(() => host.request("/api/host/config"));
  const [draft, setDraft] = React.useState(defaultBranding);
  const [saved, setSaved] = React.useState(defaultBranding);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const find = (config: any) =>
    config.plugins.find((plugin: any) =>
      /\/(?:official\.)?console$/.test(plugin.path.replaceAll("\\", "/")),
    );
  React.useEffect(() => {
    if (data.data) {
      const brand = readBranding(find(data.data)?.config ?? {});
      setDraft(brand);
      setSaved(brand);
    }
  }, [data.data]);
  React.useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function update(key: keyof Branding, value: string) {
    setDraft((old) => ({ ...old, [key]: value }));
    setMessage("");
  }
  async function upload(key: "logoUrl" | "faviconUrl", file?: File) {
    if (!file) return;
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > 64 * 1024
    ) {
      setMessage(tr("请选择不超过 64 KiB 的 PNG、JPEG 或 WebP 图片。"));
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      bitmap.close();
      const url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error(tr("图片读取失败")));
        reader.readAsDataURL(file);
      });
      update(key, url);
    } catch {
      setMessage(tr("无法读取这张图片，请选择有效的图片文件。"));
    }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const brand = readBranding({ branding: draft });
      const config = await host.request<any>("/api/host/config");
      const plugin = find(config);
      if (!plugin) throw new Error(tr("控制台插件配置不存在"));
      plugin.config = { ...plugin.config, branding: brand };
      await host.request("/api/host/config", {
        method: "PUT",
        body: JSON.stringify(config),
      });
      setDraft(brand);
      setSaved(brand);
      setMessage(tr("已保存"));
      window.dispatchEvent(new Event("pluhub:branding"));
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const input = (key: keyof Branding, label: string, placeholder = "") => (
    <label>
      {label}
      <input
        value={draft[key]}
        maxLength={brandingLimits[key]}
        placeholder={placeholder}
        onChange={(event) => update(key, event.target.value)}
        required={key === "name"}
        type={key === "supportEmail" ? "email" : "text"}
      />
    </label>
  );
  const imageInput = (key: "logoUrl" | "faviconUrl", label: string) => (
    <div className="brand-image-field">
      <label>
        {label}
        <input
          aria-label={label + tr("地址")}
          value={
            draft[key].startsWith("data:") ? tr("已上传本地图片") : draft[key]
          }
          readOnly={draft[key].startsWith("data:")}
          placeholder={tr("https://… 或上传图片")}
          onChange={(event) => update(key, event.target.value)}
        />
      </label>
      <label className="upload-control">
        {tr("上传图片")}
        <input
          type="file"
          aria-label={tr("上传") + label}
          accept="image/png,image/jpeg,image/webp"
          onChange={(event) => {
            void upload(key, event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </label>
      {draft[key] && (
        <button type="button" className="ghost" onClick={() => update(key, "")}>
          {tr("移除")}
        </button>
      )}
    </div>
  );
  const colors = brandColors(
    /^#[0-9a-f]{6}$/i.test(draft.accentColor)
      ? draft.accentColor
      : defaultBranding.accentColor,
    false,
  );
  return (
    <>
      <Notice message={data.error || message} />
      {!data.data ? (
        <p className="muted">{tr("正在读取站点设置…")}</p>
      ) : (
        <form onSubmit={(event) => void save(event)}>
          <div className="branding-layout">
            <div className="branding-fields">
              <section className="settings-form-section">
                <div>
                  <h2>{tr("品牌标识")}</h2>
                </div>
                <div className="form-grid">
                  <label>
                    {tr("站点默认语言")}
                    <Select
                      aria-label={tr("站点默认语言")}
                      value={draft.defaultLanguage}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          defaultLanguage: event.target.value as Locale,
                        })
                      }
                    >
                      <option value="zh-CN">{tr("简体中文")}</option>
                      <option value="en-US">{tr("英语")}</option>
                    </Select>
                  </label>
                  {input("name", tr("站点名称"))}
                  {input("description", tr("站点简介"))}
                  {input("accentColor", tr("主题色"), "#635bff")}
                  <div className="full">
                    {imageInput("logoUrl", "Logo")}
                    {imageInput("faviconUrl", tr("浏览器图标"))}
                    <p className="field-note">
                      {tr(
                        "PNG、JPEG、WebP，最大 64 KiB；或填写 HTTPS / 站内图片地址。",
                      )}
                    </p>
                  </div>
                </div>
              </section>
              <section className="settings-form-section">
                <div>
                  <h2>{tr("登录页面")}</h2>
                </div>
                <div className="form-grid">
                  <label className="full">
                    {tr("登录标题")}
                    <textarea
                      value={draft.loginTitle}
                      rows={3}
                      maxLength={160}
                      onChange={(event) =>
                        update("loginTitle", event.target.value)
                      }
                    />
                  </label>
                  <label className="full">
                    {tr("登录说明")}
                    <textarea
                      value={draft.loginDescription}
                      rows={3}
                      maxLength={400}
                      onChange={(event) =>
                        update("loginDescription", event.target.value)
                      }
                    />
                  </label>
                </div>
              </section>
              <section className="settings-form-section">
                <div>
                  <h2>{tr("联系与链接")}</h2>
                </div>
                <div className="form-grid">
                  {input("websiteUrl", tr("官方网站"), "https://example.com")}
                  {input("supportEmail", tr("支持邮箱"), "support@example.com")}
                  {input("termsUrl", tr("服务条款链接"))}
                  {input("privacyUrl", tr("隐私政策链接"))}
                  {input("footerText", tr("页脚文案"))}
                </div>
              </section>
            </div>
            <aside
              className="brand-preview"
              style={
                {
                  "--accent": colors.accent,
                  "--accent-soft": colors.soft,
                  "--accent-contrast": colors.ink,
                } as React.CSSProperties
              }
            >
              <div className="preview-label">
                <Icon name="overview" size={15} />
                {tr("实时预览")}
                <span>{dirty ? tr("未保存") : tr("已保存")}</span>
              </div>
              <div className="preview-console">
                <div className="brand">
                  <BrandMark brand={draft} />
                  <span className="brand-name">
                    {draft.name || tr("站点名称")}
                  </span>
                </div>
                <div className="preview-nav">{tr("总览")}</div>
                <div className="preview-lines">
                  <i />
                  <i />
                  <i />
                </div>
                <button type="button" tabIndex={-1}>
                  {tr("开始使用")}
                </button>
              </div>
              <div className="preview-login">
                <small>{tr("登录页面")}</small>
                {draft.loginTitle && <h2>{draft.loginTitle}</h2>}
                {draft.loginDescription && <p>{draft.loginDescription}</p>}
                <strong>{draft.name}</strong>
              </div>
            </aside>
          </div>
          <div className="settings-save-bar">
            <span role="status">
              {dirty ? tr("有未保存的更改") : tr("所有更改已保存")}
            </span>
            <div className="actions">
              <button
                type="button"
                className="secondary"
                disabled={busy || !dirty}
                onClick={() => {
                  setDraft(saved);
                  setMessage("");
                }}
              >
                {tr("放弃更改")}
              </button>
              <button disabled={busy || !dirty}>
                {busy ? tr("正在保存…") : tr("保存更改")}
              </button>
            </div>
          </div>
        </form>
      )}
    </>
  );
}
