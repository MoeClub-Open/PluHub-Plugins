import type { UIHost } from "@pluhub/ui-sdk";
import { useLoad } from "./mount.js";
import { Select } from "./select.js";
import { t as tr } from "./i18n.js";

export type ServiceGroupOption = {
  id: string;
  name: string;
  multiplier: number;
  channelIds: string[];
};
export function useServiceGroups(host: UIHost, guest = false) {
  return useLoad<ServiceGroupOption[]>(
    () =>
      guest
        ? Promise.resolve([])
        : host.request("/api/plugins/official.ai-router/groups"),
    [guest],
  );
}
export function ServiceGroupSelect({
  value,
  groups,
  onChange,
  disabled,
}: {
  value: string;
  groups?: ServiceGroupOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      aria-label={tr("使用分组")}
      value={value}
      disabled={disabled || !groups}
      onChange={(event) => onChange(event.target.value)}
    >
      {value !== "personal" && !groups?.some((group) => group.id === value) && (
        <option value={value}>
          {value} · {tr("不可用")}
        </option>
      )}
      {groups?.map((group) => (
        <option value={group.id} key={group.id}>
          {group.name} · ×{group.multiplier}
        </option>
      ))}
      <option value="personal">{tr("个人渠道")}</option>
    </Select>
  );
}
