import { Checkbox } from "../../lib/ui/checkbox.js";
import { t as tr, textValue, getLocale } from "../../lib/ui/i18n.js";
import React from "react";
import type { UIHost, Locale } from "@pluhub/ui-sdk";
import { readBranding } from "./branding.js";
import {
  defaultPortal,
  readPortal,
  localizePortal,
  portalTextFields,
  type PortalContent,
} from "./portal.js";
import { consoleEntry } from "./onboarding.js";
import { Notice, useLoad } from "../../lib/ui/mount.js";
import { featuredModelId } from "./portal-models.js";
import { Select } from "../../lib/ui/select.js";
import { Icon } from "../../lib/ui/components.js";

export function PortalSettings({ host }: { host: UIHost }) {
  const data = useLoad<any>(() => host.request("/api/host/config"));
  const [draft, setDraft] = React.useState(defaultPortal);
  const [tab, setTab] = React.useState("hero");
  const catalog = useLoad<any[]>(() =>
    host.request("/api/plugins/official.model-catalog/public"),
  );
  const [saved, setSaved] = React.useState(defaultPortal);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [language, setLanguage] = React.useState<Locale>(getLocale);
  const defaultLanguage = readBranding(
    consoleEntry(data.data ?? { plugins: [] })?.config ?? {},
  ).defaultLanguage;
  const content = localizePortal(draft, language, defaultLanguage);
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
    setDraft((old) =>
      (language !== defaultLanguage || old.translations?.[language]) &&
      portalTextFields.includes(key as any)
        ? {
            ...old,
            translations: {
              ...old.translations,
              [language]: { ...old.translations?.[language], [key]: value },
            },
          }
        : { ...old, [key]: value },
    );
    setMessage("");
  };
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const config = await host.request<any>("/api/host/config");
      const entry = consoleEntry(config);
      if (!entry) throw new Error(tr("控制台插件不存在"));
      const portal = readPortal({ ...entry.config, portal: draft });
      entry.config = { ...entry.config, portal };
      await host.request("/api/host/config", {
        method: "PUT",
        body: JSON.stringify(config),
      });
      setDraft(portal);
      setSaved(portal);
      setMessage(tr("已保存"));
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
          value={content[key]}
          onChange={(event) => set(key, event.target.value)}
        />
      ) : (
        <input
          value={content[key]}
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
    const items = content[key] as unknown as Record<string, string>[];
    return (
      <section className="settings-form-section" hidden={tab !== key}>
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
            <legend>{item.title || item.question || title}</legend>
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
          <label>
            {tr("内容语言")}
            <Select
              value={language}
              onChange={(event) => setLanguage(event.target.value as Locale)}
            >
              <option value="zh-CN">{tr("简体中文")}</option>
              <option value="en-US">{tr("英语")}</option>
            </Select>
          </label>
          <div className="tabs" role="tablist" aria-label={tr("门户设置")}>
            {[
              ["hero", "首页布局"],
              ["models", "精选模型"],
              ["features", "服务特色"],
              ["faqs", "常见问题"],
              ["pages", "公开页面"],
            ].map(([id, label]) => (
              <button
                type="button"
                key={id}
                role="tab"
                aria-selected={tab === id}
                className={tab === id ? "active" : ""}
                onClick={() => setTab(id!)}
              >
                {tr(label!)}
              </button>
            ))}
          </div>
          <section className="settings-form-section" hidden={tab !== "hero"}>
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
              <label>
                {tr("首页布局")}
                <Select
                  value={draft.layout}
                  onChange={(e) =>
                    set("layout", e.target.value as PortalContent["layout"])
                  }
                >
                  <option value="split">{tr("模型橱窗")}</option>
                  <option value="centered">{tr("居中布局")}</option>
                </Select>
              </label>
              {field("eyebrow", tr("分类标签"))}
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
              {tr("显示 API 地址")}
            </label>
          </section>
          <section className="settings-form-section" hidden={tab !== "models"}>
            <div className="form-grid">
              {(catalog.data ?? [])
                .filter(
                  (model) =>
                    (model.operations ?? ["chat"]).includes("chat") &&
                    model.pricing?.mode !== "request",
                )
                .map((model) => {
                  const id = featuredModelId(model),
                    selected = draft.featuredModels.includes(id);
                  return (
                    <label className="checkbox" key={id}>
                      <Checkbox
                        checked={selected}
                        disabled={!selected && draft.featuredModels.length >= 8}
                        onCheckedChange={(checked) =>
                          set(
                            "featuredModels",
                            checked
                              ? [...draft.featuredModels, id]
                              : draft.featuredModels.filter(
                                  (value) => value !== id,
                                ),
                          )
                        }
                      />
                      {model.name} · {model.channel?.name}
                    </label>
                  );
                })}
            </div>
          </section>
          {collection(
            "features",
            tr("服务特色"),
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
