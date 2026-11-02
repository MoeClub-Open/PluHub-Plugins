import { Icon } from "../../lib/ui/components.js";
import { t } from "../../lib/ui/i18n.js";
import React from "react";
import * as Popover from "@radix-ui/react-popover";
import { Palette } from "lucide-react";
import { siteThemes, type PalettePreference } from "./site-themes.js";
import type { Theme } from "./theme.js";

export function PalettePicker({
  value,
  change,
  followSite = false,
}: {
  value: PalettePreference;
  change: (value: PalettePreference) => void;
  followSite?: boolean;
}) {
  const id = React.useId();
  return (
    <fieldset className="appearance-fieldset">
      <legend>{t("颜色主题")}</legend>
      <div className="appearance-palettes">
        {followSite && (
          <label className="appearance-palette appearance-site">
            <input
              type="radio"
              name={id}
              value="site"
              checked={value === "site"}
              onChange={() => change("site")}
            />
            <span className="appearance-swatch appearance-site-swatch">
              <Icon name="settings" size={13} />
            </span>
            <span>{t("跟随站点")}</span>
            <Icon name="check" size={14} />
          </label>
        )}
        {Object.entries(siteThemes).map(([key, theme]) => (
          <label
            className="appearance-palette"
            key={key}
            style={{ "--swatch": theme.accent } as React.CSSProperties}
          >
            <input
              type="radio"
              name={id}
              value={key}
              checked={value === key}
              onChange={() => change(key as PalettePreference)}
            />
            <span className="appearance-swatch" />
            <span>{t(theme.name)}</span>
            <Icon name="check" size={14} />
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function ThemeButton({ theme }: { theme: Theme }) {
  const id = React.useId();
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          className="ghost icon-button appearance-trigger"
          aria-label={t("界面外观")}
          title={t("界面外观")}
        >
          <Palette size={17} strokeWidth={1.6} aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="appearance-popover"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          aria-label={t("界面外观")}
        >
          <div className="appearance-heading">
            <strong>{t("界面外观")}</strong>
            <Popover.Close asChild>
              <button
                className="ghost icon-button"
                aria-label={t("关闭外观设置")}
              >
                <Icon name="close" size={14} />
              </button>
            </Popover.Close>
          </div>
          <fieldset className="appearance-fieldset">
            <legend>{t("明暗模式")}</legend>
            <div className="appearance-modes">
              {(
                [
                  ["system", "monitor", "跟随系统"],
                  ["light", "sun", "浅色"],
                  ["dark", "moon", "深色"],
                ] as const
              ).map(([mode, icon, label]) => (
                <label key={mode} className="appearance-mode">
                  <input
                    type="radio"
                    name={id}
                    value={mode}
                    checked={theme.mode === mode}
                    onChange={() => theme.change(mode)}
                  />
                  <Icon name={icon} size={16} />
                  <span>{t(label)}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <PalettePicker
            value={theme.palette}
            change={theme.changePalette}
            followSite
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
