import React from "react";
export type ThemeMode = "system" | "light" | "dark";
const key = "pluhub.theme";
export function readThemeMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(key);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}
export function useTheme() {
  const [mode, setMode] = React.useState<ThemeMode>(readThemeMode);
  const [systemDark, setSystemDark] = React.useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  React.useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const changed = () => setSystemDark(media.matches);
    changed();
    media.addEventListener("change", changed);
    const storage = (event: StorageEvent) => {
      if (event.key === key || event.key === null) setMode(readThemeMode());
    };
    window.addEventListener("storage", storage);
    return () => {
      media.removeEventListener("change", changed);
      window.removeEventListener("storage", storage);
    };
  }, []);
  const dark = mode === "system" ? systemDark : mode === "dark";
  React.useLayoutEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
  const change = (next: ThemeMode) => {
    setMode(next);
    try {
      localStorage.setItem(key, next);
    } catch {
      /* Apply the preference even when storage is unavailable. */
    }
  };
  return { mode, dark, change, toggle: () => change(dark ? "light" : "dark") };
}
