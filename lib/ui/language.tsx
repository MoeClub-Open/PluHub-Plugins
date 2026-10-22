import React from "react";
import { type Locale } from "@pluhub/ui-sdk";
import { Select } from "./select.js";
import {
  getLocale,
  setLanguagePreference,
  subscribeLanguage,
  t,
} from "./i18n.js";

export function useLocale() {
  return React.useSyncExternalStore(
    subscribeLanguage,
    getLocale,
    () => "zh-CN" as const,
  );
}
export function LanguagePicker({ compact = false }: { compact?: boolean }) {
  const locale = useLocale();
  return (
    <div
      className={
        "language-picker" + (compact ? " language-picker-compact" : "")
      }
    >
      <Select
        aria-label={t("界面语言")}
        title={t("界面语言")}
        value={locale}
        onChange={(event) =>
          setLanguagePreference(event.target.value as Locale)
        }
      >
        <option value="zh-CN">{t("简体中文")}</option>
        <option value="en-US">{t("英语")}</option>
      </Select>
    </div>
  );
}
