import type { Locale } from "@pluhub/ui-sdk";

export function matchLocale(
  languages: readonly string[],
  fallback: Locale,
): Locale {
  for (const language of languages) {
    const base = language.toLowerCase().split(/[-_]/)[0];
    if (base === "zh") return "zh-CN";
    if (base === "en") return "en-US";
  }
  return fallback;
}

export function requestLocale(request: Request, fallback: Locale): Locale {
  const languages = (request.headers.get("accept-language") ?? "")
    .split(",")
    .map((item) => {
      const [language = "", quality] = item.trim().split(";");
      return {
        language,
        quality: quality ? Number(quality.trim().replace(/^q=/, "")) : 1,
      };
    })
    .filter((item) => item.quality > 0)
    .sort((a, b) => b.quality - a.quality);
  return matchLocale(
    languages.map((item) => item.language),
    fallback,
  );
}
