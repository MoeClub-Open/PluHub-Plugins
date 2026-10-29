import {
  isLocale,
  translateMessage,
  type Locale,
  type MessageCatalog,
  type MessageValues,
  type UIInternationalization,
} from "@pluhub/ui-sdk";
import { matchLocale } from "./locale.js";

export type LanguagePreference = Locale | "auto";

const event = "pluhub:language";
const storageKey = "pluhub.language";
const accountStorageKey = "pluhub.language.account";
const preferenceEvent = "pluhub:language-preference";
const accountEvent = "pluhub:language-account";
let catalog: MessageCatalog = {};
let hostLanguage: UIInternationalization | undefined;
export function configureMessages(messages: MessageCatalog) {
  catalog = messages;
}
export function bindInternationalization(service?: UIInternationalization) {
  hostLanguage = service === internationalization ? undefined : service;
}
/** Match React's rendering of primitive children during message interpolation. */
export function textValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}
export function getLocale(): Locale {
  return typeof document !== "undefined" &&
    isLocale(document.documentElement.lang)
    ? document.documentElement.lang
    : "zh-CN";
}
export function getLanguagePreference(): Locale | undefined {
  const root = document.documentElement;
  const value = root.dataset.languageAccount
    ? root.dataset.accountLanguage
    : root.dataset.languagePreference;
  return isLocale(value) ? value : undefined;
}
export function t(source: string, values?: MessageValues): string {
  return hostLanguage
    ? hostLanguage.t(source, values)
    : translateMessage(getLocale(), source, catalog, values);
}
export function subscribeLanguage(listener: () => void) {
  window.addEventListener(event, listener);
  return () => window.removeEventListener(event, listener);
}
function applyLanguage() {
  const root = document.documentElement;
  const preference = getLanguagePreference();
  const site = root.dataset.siteLanguage;
  const locale =
    preference ??
    matchLocale(
      navigator.languages?.length ? navigator.languages : [navigator.language],
      isLocale(site) ? site : "zh-CN",
    );
  root.lang = locale;
  window.dispatchEvent(new Event(event));
}
export function setSiteLanguage(locale: Locale) {
  if (!isLocale(locale)) return;
  const root = document.documentElement;
  if (root.dataset.siteLanguage === locale) return;
  root.dataset.siteLanguage = locale;
  applyLanguage();
}
export function setAccountLanguage(id?: string, locale?: unknown) {
  const root = document.documentElement;
  root.dataset.languageAccount = id ?? "";
  root.dataset.accountLanguage = id && isLocale(locale) ? locale : "";
  // Cancel queued saves belonging to a previous login before applying a new one.
  window.dispatchEvent(new Event(accountEvent));
  applyLanguage();
}
export function setLanguagePreference(value: LanguagePreference) {
  if (value !== "auto" && !isLocale(value)) return;
  const root = document.documentElement;
  const id = root.dataset.languageAccount;
  const language = value === "auto" ? null : value;
  if (id) root.dataset.accountLanguage = language ?? "";
  else root.dataset.languagePreference = language ?? "";
  try {
    if (id)
      localStorage.setItem(accountStorageKey, JSON.stringify({ id, language }));
    else if (language) localStorage.setItem(storageKey, language);
    else localStorage.removeItem(storageKey);
  } catch {
    /* Language switching still works when browser storage is unavailable. */
  }
  applyLanguage();
  if (id)
    window.dispatchEvent(
      new CustomEvent(preferenceEvent, {
        detail: { id, language },
      }),
    );
}
function readPreference() {
  try {
    const value = localStorage.getItem(storageKey);
    return isLocale(value) ? value : "";
  } catch {
    return "";
  }
}
export function initializeLanguage(site: Locale) {
  document.documentElement.dataset.languageAccount = "";
  document.documentElement.dataset.accountLanguage = "";
  document.documentElement.dataset.languagePreference = readPreference();
  document.documentElement.dataset.siteLanguage = site;
  applyLanguage();
}
export function syncLanguagePreferences(
  save?: (locale: Locale | null, signal: AbortSignal) => Promise<unknown>,
  onError?: () => void,
) {
  let queued: { id: string; language: Locale | null } | undefined;
  let running = false,
    stopped = false;
  let controller: AbortController | undefined;
  const cancel = () => {
    queued = undefined;
    controller?.abort();
  };
  const persist = async () => {
    if (running || !save) return;
    running = true;
    try {
      while (!stopped && queued) {
        const next = queued;
        queued = undefined;
        if (next.id !== document.documentElement.dataset.languageAccount)
          continue;
        controller = new AbortController();
        try {
          await save(next.language, controller.signal);
        } catch {
          if (!controller.signal.aborted && !stopped) onError?.();
        }
      }
    } finally {
      running = false;
    }
  };
  const changed = (change: Event) => {
    const next = (change as CustomEvent).detail;
    if (
      !next ||
      (next.language !== null && !isLocale(next.language)) ||
      next.id !== document.documentElement.dataset.languageAccount
    )
      return;
    queued = next;
    void persist();
  };
  const sync = (change: StorageEvent) => {
    if (![storageKey, accountStorageKey, null].includes(change.key)) return;
    document.documentElement.dataset.languagePreference = readPreference();
    if (change.key === accountStorageKey && change.newValue) {
      try {
        const next = JSON.parse(change.newValue);
        if (
          next.id === document.documentElement.dataset.languageAccount &&
          (next.language === null || isLocale(next.language))
        )
          document.documentElement.dataset.accountLanguage =
            next.language ?? "";
      } catch {
        /* Ignore malformed or unrelated browser cache. */
      }
    }
    applyLanguage();
  };
  window.addEventListener("storage", sync);
  window.addEventListener(preferenceEvent, changed);
  window.addEventListener(accountEvent, cancel);
  window.addEventListener("languagechange", applyLanguage);
  return () => {
    stopped = true;
    cancel();
    window.removeEventListener("storage", sync);
    window.removeEventListener(preferenceEvent, changed);
    window.removeEventListener(accountEvent, cancel);
    window.removeEventListener("languagechange", applyLanguage);
  };
}
export const internationalization: UIInternationalization = {
  get locale() {
    return getLocale();
  },
  t(source: string, values?: MessageValues, catalog?: MessageCatalog) {
    return catalog
      ? translateMessage(getLocale(), source, catalog, values)
      : t(source, values);
  },
  subscribe: subscribeLanguage,
};
