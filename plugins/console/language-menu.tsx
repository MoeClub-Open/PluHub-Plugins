import * as Select from "@radix-ui/react-select";
import { Languages, Check } from "lucide-react";
import { useLanguagePreference } from "../../lib/ui/language.js";
import {
  setLanguagePreference,
  t,
  type LanguagePreference,
} from "../../lib/ui/i18n.js";

export function LanguageMenu() {
  const preference = useLanguagePreference();
  const options = [
    { value: "auto", label: t("跟随浏览器") },
    { value: "zh-CN", label: t("简体中文") },
    { value: "en-US", label: t("英语") },
  ];
  return (
    <Select.Root
      value={preference}
      onValueChange={(value) =>
        setLanguagePreference(value as LanguagePreference)
      }
    >
      <Select.Trigger
        className="language-menu"
        aria-label={t("界面语言")}
        title={`${t("界面语言")}: ${options.find((item) => item.value === preference)?.label}`}
      >
        <Languages size={16} strokeWidth={1.6} aria-hidden="true" />
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          className="select-options language-options"
          position="popper"
          align="end"
          sideOffset={5}
          collisionPadding={8}
          aria-label={t("界面语言")}
        >
          <Select.Viewport>
            {options.map((option) => (
              <Select.Item
                key={option.value}
                value={option.value}
                textValue={option.label}
              >
                <Select.ItemText>{option.label}</Select.ItemText>
                <Select.ItemIndicator>
                  <Check size={14} aria-hidden="true" />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
