import { safeBrandUrl, readBranding } from "./branding.js";
import { isLocale, type Locale } from "@pluhub/ui-sdk";

export const portalTextFields = [
  "eyebrow",
  "title",
  "description",
  "announcement",
  "primaryLabel",
  "primaryUrl",
  "docsUrl",
  "features",
  "faqs",
  "pages",
] as const;
type PortalText = Pick<PortalContent, (typeof portalTextFields)[number]>;

export interface PortalContent {
  enabled: boolean;
  eyebrow: string;
  title: string;
  description: string;
  announcement: string;
  primaryLabel: string;
  primaryUrl: string;
  docsUrl: string;
  showEndpoint: boolean;
  layout: "split" | "centered";
  featuredModels: string[];
  features: { title: string; description: string }[];
  faqs: { question: string; answer: string }[];
  pages: { slug: string; title: string; body: string }[];
  translations?: Partial<Record<Locale, Partial<PortalText>>>;
}
export const defaultPortal: PortalContent = {
  enabled: true,
  eyebrow: "",
  title: "多模型 API\n与在线对话",
  description: "",
  announcement: "",
  primaryLabel: "浏览模型",
  primaryUrl: "#/models",
  docsUrl: "",
  showEndpoint: true,
  layout: "split",
  featuredModels: [],
  features: [],
  faqs: [],
  pages: [],
  translations: {},
};
export const portalUrl = (value: string) =>
  /^#\/(?:console|login|models|public\/[a-z0-9-]+)$/.test(value) ||
  safeBrandUrl(value);

export function defaultPortalFor(locale: Locale): PortalContent {
  const result = structuredClone(defaultPortal);
  if (locale === "en-US") {
    result.title = "AI models.\nFor chat and API.";
    result.description = "";
    result.primaryLabel = "Browse models";
  }
  return result;
}

function readContent(raw: unknown, locale: Locale): PortalContent {
  const defaults = defaultPortalFor(locale);
  if (raw === undefined) return defaults;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("门户配置必须为对象");
  const data = raw as Record<string, unknown>;
  if (Object.keys(data).some((key) => !Object.hasOwn(defaultPortal, key)))
    throw new Error("未知的门户字段");
  const result = {
    ...defaults,
    ...structuredClone(data),
  } as PortalContent;
  if (!["split", "centered"].includes(result.layout))
    throw new Error("无效的门户布局");
  if (
    !Array.isArray(result.featuredModels) ||
    result.featuredModels.length > 8 ||
    result.featuredModels.some(
      (id) => typeof id !== "string" || !id || id.length > 1024,
    )
  )
    throw new Error("无效的精选模型");
  for (const key of ["enabled", "showEndpoint"] as const)
    if (typeof result[key] !== "boolean") throw new Error("无效的门户开关");
  const limits = {
    eyebrow: 80,
    title: 160,
    description: 600,
    announcement: 600,
    primaryLabel: 40,
    primaryUrl: 2048,
    docsUrl: 2048,
  };
  for (const [key, limit] of Object.entries(limits)) {
    const value = result[key as keyof typeof limits];
    if (typeof value !== "string" || value.length > limit)
      throw new Error("无效的门户字段：" + key);
    (result as any)[key] = value.trim();
  }
  if (!result.title || !result.primaryLabel || !result.primaryUrl)
    throw new Error("请填写门户标题与主按钮");
  if (!portalUrl(result.primaryUrl) || !portalUrl(result.docsUrl))
    throw new Error("门户链接仅支持本站路径或 HTTPS 地址");
  function list(
    key: "features" | "faqs" | "pages",
    fields: Record<string, number>,
    maximum: number,
  ) {
    const items = result[key];
    if (!Array.isArray(items) || items.length > maximum)
      throw new Error("门户列表数量超限：" + key);
    for (const item of items) {
      if (
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        Object.keys(item).some((field) => !Object.hasOwn(fields, field))
      )
        throw new Error("无效的门户列表：" + key);
      for (const [field, limit] of Object.entries(fields)) {
        const value = (item as any)[field];
        if (typeof value !== "string" || !value.trim() || value.length > limit)
          throw new Error("请检查公开内容：" + field);
        (item as any)[field] = value.trim();
      }
    }
  }
  list("features", { title: 80, description: 400 }, 6);
  list("faqs", { question: 160, answer: 2000 }, 8);
  list("pages", { slug: 40, title: 80, body: 20000 }, 8);
  if (
    result.pages.some((page) => !/^[a-z][a-z0-9-]{0,39}$/.test(page.slug)) ||
    new Set(result.pages.map((page) => page.slug)).size !== result.pages.length
  )
    throw new Error("公开页面标识必须唯一，并使用小写字母、数字和连字符");
  return result;
}

export function readPortal(config: Record<string, unknown>): PortalContent {
  const locale = readBranding(config).defaultLanguage;
  const result = readContent(config.portal, locale);
  const translations = result.translations ?? {};
  if (
    !translations ||
    typeof translations !== "object" ||
    Array.isArray(translations)
  )
    throw new Error("无效的门户翻译");
  result.translations = {};
  for (const [language, value] of Object.entries(translations)) {
    if (
      !isLocale(language) ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value)
    )
      throw new Error("无效的门户翻译");
    const keys = Object.keys(value);
    if (keys.some((key) => !portalTextFields.includes(key as keyof PortalText)))
      throw new Error("未知的门户翻译字段");
    const validated = readContent(
      { ...result, ...value, translations: {} },
      language,
    );
    result.translations[language] = Object.fromEntries(
      keys.map((key) => [key, validated[key as keyof PortalText]]),
    );
  }
  return result;
}

export function localizePortal(
  content: PortalContent,
  locale: Locale,
  fallback: Locale,
): PortalContent {
  const source = defaultPortalFor(fallback);
  const target = defaultPortalFor(locale);
  const defaults = Object.fromEntries(
    (["title", "primaryLabel"] as const).map((key) => [
      key,
      content[key] === source[key] ? target[key] : content[key],
    ]),
  );
  return { ...content, ...defaults, ...content.translations?.[locale] };
}

export function publicPortal(config: Record<string, unknown>) {
  const portal = readPortal(config);
  return portal.enabled
    ? portal
    : {
        ...defaultPortalFor(readBranding(config).defaultLanguage),
        enabled: false,
        announcement: "",
        docsUrl: "",
        features: [],
        faqs: [],
        pages: [],
      };
}
