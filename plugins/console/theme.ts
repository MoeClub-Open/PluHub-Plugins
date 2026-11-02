import React from "react";
import { isSiteTheme, type PalettePreference } from "./site-themes.js";
export type ThemeMode = "system" | "light" | "dark";
const key = "pluhub.theme";
const paletteKey = "pluhub.palette";
const themeEvent = "pluhub:theme";
export function readThemeMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(key);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}
function readPalette(): PalettePreference {
  try {
    const saved = localStorage.getItem(paletteKey);
    return isSiteTheme(saved) ? saved : "site";
  } catch {
    return "site";
  }
}
export function useTheme() {
  const [mode, setMode] = React.useState<ThemeMode>(readThemeMode);
  const [palette, setPalette] = React.useState<PalettePreference>(readPalette);
  const [systemDark, setSystemDark] = React.useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  React.useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const changed = () => setSystemDark(media.matches);
    changed();
    media.addEventListener("change", changed);
    const storage = (event: StorageEvent) => {
      if ([key, paletteKey, null].includes(event.key)) {
        setMode(readThemeMode());
        setPalette(readPalette());
      }
    };
    window.addEventListener("storage", storage);
    const localChange = (event: Event) => {
      const next = (
        event as CustomEvent<{ mode?: ThemeMode; palette?: PalettePreference }>
      ).detail;
      if (next.mode) setMode(next.mode);
      if (next.palette) setPalette(next.palette);
    };
    window.addEventListener(themeEvent, localChange);
    return () => {
      media.removeEventListener("change", changed);
      window.removeEventListener("storage", storage);
      window.removeEventListener(themeEvent, localChange);
    };
  }, []);
  const dark = mode === "system" ? systemDark : mode === "dark";
  React.useLayoutEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
  const change = (next: ThemeMode) => {
    setMode(next);
    window.dispatchEvent(
      new CustomEvent(themeEvent, { detail: { mode: next } }),
    );
    try {
      localStorage.setItem(key, next);
    } catch {
      /* Apply the preference even when storage is unavailable. */
    }
  };
  const changePalette = (next: PalettePreference) => {
    setPalette(next);
    window.dispatchEvent(
      new CustomEvent(themeEvent, { detail: { palette: next } }),
    );
    try {
      if (next === "site") localStorage.removeItem(paletteKey);
      else localStorage.setItem(paletteKey, next);
    } catch {
      /* Apply the preference even when storage is unavailable. */
    }
  };
  return { mode, dark, change, palette, changePalette };
}
export type Theme = ReturnType<typeof useTheme>;
