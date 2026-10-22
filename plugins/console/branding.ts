import { isLocale, type Locale } from "@pluhub/ui-sdk";
export interface Branding {
  defaultLanguage: Locale;
  name: string;
  description: string;
  logoUrl: string;
  faviconUrl: string;
  accentColor: string;
  loginTitle: string;
  loginDescription: string;
  footerText: string;
  supportEmail: string;
  websiteUrl: string;
  termsUrl: string;
  privacyUrl: string;
}

export const defaultBranding: Branding = {
  defaultLanguage: "zh-CN",
  name: "PluHub",
  description: "AI 模型服务",
  logoUrl: "",
  faviconUrl: "",
  accentColor: "#635bff",
  loginTitle: "",
  loginDescription: "",
  footerText: "",
  supportEmail: "",
  websiteUrl: "",
  termsUrl: "",
  privacyUrl: "",
};

export const brandingLimits: Record<keyof Branding, number> = {
  defaultLanguage: 5,
  name: 64,
  description: 200,
  logoUrl: 90000,
  faviconUrl: 90000,
  accentColor: 7,
  loginTitle: 160,
  loginDescription: 400,
  footerText: 200,
  supportEmail: 254,
  websiteUrl: 2048,
  termsUrl: 2048,
  privacyUrl: 2048,
};

export function safeBrandUrl(value: string, image = false) {
  if (!value) return true;
  if (/[\u0000-\u0020\u007f\\]/.test(value)) return false;
  if (
    image &&
    /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    return true;
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function readBranding(config: Record<string, unknown>): Branding {
  const raw = config.branding;
  if (raw === undefined) return { ...defaultBranding };
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("品牌配置必须为对象");
  const result = { ...defaultBranding };
  for (const [key, value] of Object.entries(raw)) {
    if (key === "defaultLanguage") {
      if (!isLocale(value)) throw new Error("不支持的站点语言");
      result.defaultLanguage = value;
      continue;
    }
    // Accept saved legacy configuration without publishing the retired field.
    if (
      key === "workspaceName" &&
      typeof value === "string" &&
      value.length <= 64
    )
      continue;
    if (
      !Object.hasOwn(defaultBranding, key) ||
      typeof value !== "string" ||
      value.length > brandingLimits[key as keyof Branding]
    )
      throw new Error("无效的品牌字段：" + key);
    result[key as Exclude<keyof Branding, "defaultLanguage">] = value.trim();
  }
  if (!result.name) throw new Error("请填写站点名称");
  if (
    result.defaultLanguage === "en-US" &&
    (raw as Record<string, unknown>).description === undefined
  )
    result.description = "AI model service";
  if (!/^#[0-9a-f]{6}$/i.test(result.accentColor))
    throw new Error("主题色必须为六位十六进制颜色");
  for (const key of [
    "logoUrl",
    "faviconUrl",
    "websiteUrl",
    "termsUrl",
    "privacyUrl",
  ] as const)
    if (!safeBrandUrl(result[key], key === "logoUrl" || key === "faviconUrl"))
      throw new Error("无效的品牌链接：" + key);
  if (
    result.supportEmail &&
    !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(result.supportEmail)
  )
    throw new Error("请填写有效的支持邮箱");
  return result;
}

export function escapeHtml(text: string) {
  return text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}

const rgb = (hex: string) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex = (values: number[]) =>
  "#" +
  values
    .map((value) => Math.round(value).toString(16).padStart(2, "0"))
    .join("");
const mix = (a: string, b: string, weight: number) =>
  hex(rgb(a).map((value, i) => value * (1 - weight) + rgb(b)[i]! * weight));
const luminance = (color: string) =>
  rgb(color)
    .map((value) => {
      const v = value / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i]!, 0);
export const contrast = (a: string, b: string) =>
  (Math.max(luminance(a), luminance(b)) + 0.05) /
  (Math.min(luminance(a), luminance(b)) + 0.05);
export function brandColors(color: string, dark: boolean) {
  const surface = dark ? "#202737" : "#ffffff";
  let accent = color;
  let soft = mix(accent, surface, dark ? 0.83 : 0.93);
  for (
    let n = 1;
    n <= 100 &&
    (contrast(accent, surface) < 4.5 || contrast(accent, soft) < 4.5);
    n++
  ) {
    accent = mix(color, dark ? "#ffffff" : "#000000", n / 100);
    soft = mix(accent, surface, dark ? 0.83 : 0.93);
  }
  return {
    accent,
    soft,
    ink: contrast(accent, "#ffffff") >= 4.5 ? "#ffffff" : "#000000",
  };
}
