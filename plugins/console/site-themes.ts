export const siteThemes = {
  graphite: {
    name: "石墨",
    accent: "#52525b",
    radius: "6px",
    light: ["#fafafa", "#ffffff", "#f2f2f3", "#18181b", "#65656f", "#e4e4e7"],
    dark: ["#111113", "#18181b", "#222225", "#f4f4f5", "#a1a1aa", "#303035"],
  },
  ocean: {
    name: "深海",
    accent: "#2563eb",
    radius: "6px",
    light: ["#f8fafc", "#ffffff", "#eef2f7", "#172033", "#5e6b80", "#dde4ee"],
    dark: ["#0c1320", "#121c2d", "#1b2940", "#eef3fb", "#9eabc0", "#2a3850"],
  },
  violet: {
    name: "鸢尾",
    accent: "#635bff",
    radius: "8px",
    light: ["#faf9fd", "#ffffff", "#f0eef7", "#211c30", "#706780", "#e6e1ee"],
    dark: ["#131019", "#1c1824", "#272031", "#f5f0fb", "#aba1bb", "#352d40"],
  },
} as const;
export type SiteTheme = keyof typeof siteThemes;
export function themeVariables(theme: SiteTheme, dark: boolean) {
  const selected = siteThemes[theme];
  return {
    ...Object.fromEntries(
      ["bg", "surface", "subtle", "text", "muted", "border"].map(
        (key, index) => ["--" + key, selected[dark ? "dark" : "light"][index]],
      ),
    ),
    "--radius": selected.radius,
  };
}
