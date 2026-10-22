import { safeBrandUrl, readBranding } from "./branding.js";
import type { Locale } from "@pluhub/ui-sdk";

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
  features: { title: string; description: string }[];
  faqs: { question: string; answer: string }[];
  pages: { slug: string; title: string; body: string }[];
}
export const defaultPortal: PortalContent = {
  enabled: true,
  eyebrow: "",
  title: "AI 模型服务",
  description: "在线对话或通过 API 调用模型。",
  announcement: "",
  primaryLabel: "浏览模型",
  primaryUrl: "#/models",
  docsUrl: "",
  showEndpoint: true,
  features: [],
  faqs: [
    {
      question: "如何收费？",
      answer:
        "模型目录展示每百万 Token 的模型原价。实际扣费按用量与所选渠道的消耗倍率计算，可登录后查看用量与账单。",
    },
  ],
  pages: [],
};
export const portalUrl = (value: string) =>
  /^#\/(?:console|login|models|public\/[a-z0-9-]+)$/.test(value) ||
  safeBrandUrl(value);

export function defaultPortalFor(locale: Locale): PortalContent {
  const result = structuredClone(defaultPortal);
  if (locale === "en-US") {
    result.title = "AI model service";
    result.description = "Chat online or use models through the API.";
    result.primaryLabel = "Browse models";
    result.faqs = [
      {
        question: "How does pricing work?",
        answer:
          "The catalog shows original model prices per million tokens. Charges depend on usage and the selected channel's usage multiplier. Sign in to view usage and billing.",
      },
    ];
  }
  return result;
}

export function readPortal(config: Record<string, unknown>): PortalContent {
  const raw = config.portal;
  const defaults = defaultPortalFor(readBranding(config).defaultLanguage);
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
