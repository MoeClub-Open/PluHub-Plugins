import { Icon } from "../../lib/ui/components.js";
import { t } from "../../lib/ui/i18n.js";
import type { ThemeMode } from "./theme.js";

export function ThemeButton({
  theme,
}: {
  theme: { mode: ThemeMode; change: (mode: ThemeMode) => void };
}) {
  const names = { system: t("跟随系统"), light: t("浅色"), dark: t("深色") };
  const next =
    theme.mode === "system"
      ? "light"
      : theme.mode === "light"
        ? "dark"
        : "system";
  return (
    <button
      className="ghost icon-button"
      aria-label={
        t("颜色模式：") + names[theme.mode] + t("，点击切换为") + names[next]
      }
      title={t("颜色模式：") + names[theme.mode]}
      onClick={() => theme.change(next)}
    >
      <Icon
        name={
          theme.mode === "system"
            ? "monitor"
            : theme.mode === "dark"
              ? "moon"
              : "sun"
        }
        size={16}
      />
    </button>
  );
}
