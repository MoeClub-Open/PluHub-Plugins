export const siteThemes = {
  graphite: {
    name: "石墨",
    accent: "#52525b",
    light: ["#f7f7f8", "#ffffff", "#f1f1f3", "#18181b", "#64646e", "#e4e4e7"],
    dark: ["#0f1012", "#18191d", "#222328", "#f4f4f5", "#a1a1aa", "#303139"],
  },
  ocean: {
    name: "深海",
    accent: "#2563eb",
    light: ["#f6f8fc", "#ffffff", "#edf2fa", "#172235", "#5e6c82", "#dde4ee"],
    dark: ["#0e131c", "#161e2b", "#202c3d", "#edf3fc", "#a4b2c8", "#2d3b50"],
  },
  violet: {
    name: "鸢尾",
    accent: "#635bff",
    light: ["#f8f7fc", "#ffffff", "#f0edf8", "#241d32", "#70647f", "#e5dfef"],
    dark: ["#15121d", "#1e1929", "#2a2237", "#f4effb", "#b3a5c6", "#3a3049"],
  },
  emerald: {
    name: "松绿",
    accent: "#168263",
    light: ["#f5faf8", "#ffffff", "#eaf4f0", "#162c24", "#5e746a", "#dbe9e2"],
    dark: ["#0e1714", "#15221d", "#20332a", "#eef8f2", "#a0baac", "#2c4438"],
  },
  amber: {
    name: "琥珀",
    accent: "#a16207",
    light: ["#fbf9f5", "#ffffff", "#f5efe4", "#2e261b", "#7b6d59", "#eae2d5"],
    dark: ["#19150f", "#241e15", "#332a1e", "#faf4e8", "#bfb097", "#493c2a"],
  },
  rose: {
    name: "蔷薇",
    accent: "#c43d68",
    light: ["#fcf7f8", "#ffffff", "#f8ecef", "#321e26", "#806773", "#efdee5"],
    dark: ["#1a1216", "#281b22", "#38262f", "#fcedf3", "#c6a6b5", "#4b3340"],
  },
} as const;
export type SiteTheme = keyof typeof siteThemes;
export type PalettePreference = SiteTheme | "site";
export function isSiteTheme(value: unknown): value is SiteTheme {
  return typeof value === "string" && Object.hasOwn(siteThemes, value);
}
export function themeVariables(theme: SiteTheme, dark: boolean) {
  const selected = siteThemes[theme];
  return {
    ...Object.fromEntries(
      ["bg", "surface", "subtle", "text", "muted", "border"].map(
        (key, index) => ["--" + key, selected[dark ? "dark" : "light"][index]],
      ),
    ),
  };
}
