import React from "react";
import { Select } from "./select.js";
import {
  getLocale,
  getLanguagePreference,
  setLanguagePreference,
  subscribeLanguage,
  t,
  type LanguagePreference,
} from "./i18n.js";

export function useLocale() {
  return React.useSyncExternalStore(
    subscribeLanguage,
    getLocale,
    () => "zh-CN" as const,
  );
}
export function useLanguagePreference() {
  useLocale();
  return React.useSyncExternalStore(
    subscribeLanguage,
    () => getLanguagePreference() ?? "auto",
    () => "auto" as const,
  );
}
export function LanguagePicker({ compact = false }: { compact?: boolean }) {
  const preference = useLanguagePreference();
  return (
    <div
      className={
        "language-picker" + (compact ? " language-picker-compact" : "")
      }
    >
      <Select
        aria-label={t("界面语言")}
        title={t("界面语言")}
        value={preference}
        onChange={(event) =>
          setLanguagePreference(event.target.value as LanguagePreference)
        }
      >
        <option value="auto">{t("跟随浏览器")}</option>
        <option value="zh-CN">{t("简体中文")}</option>
        <option value="en-US">{t("英语")}</option>
      </Select>
    </div>
  );
}
