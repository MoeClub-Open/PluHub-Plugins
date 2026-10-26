import { t as tr } from "../../lib/ui/i18n.js";
import React from "react";
import type { ServiceGroupOption } from "../../lib/ui/service-groups.js";
import { Checkbox } from "../../lib/ui/checkbox.js";
import { Select } from "../../lib/ui/select.js";

export type KeyChannel = {
  id: string;
  name: string;
  scope: string;
  consumptionMultiplier?: number;
};
export function ChannelBinding({
  channels,
  groups,
  initialChannels = [],
  initialGroup,
  disabled = false,
}: {
  channels: KeyChannel[];
  groups?: ServiceGroupOption[];
  initialChannels?: string[];
  initialGroup?: string | null;
  disabled?: boolean;
}) {
  const [scope, setScope] = React.useState(
    initialGroup
      ? "group:" + initialGroup
      : initialChannels.length
        ? "personal"
        : "group:default",
  );
  const [selected, setSelected] = React.useState(initialChannels);
  const personal = [
    ...channels.filter((c) => c.scope === "personal"),
    ...initialChannels
      .filter(
        (id) =>
          id.startsWith("personal:") && !channels.some((c) => c.id === id),
      )
      .map((id) => ({
        id,
        name: id + " · " + tr("不可用"),
        scope: "personal",
      })),
  ];
  const availableGroups = [
    ...(groups ?? []),
    ...(initialGroup && !groups?.some((g) => g.id === initialGroup)
      ? [
          {
            id: initialGroup,
            name: initialGroup + " · " + tr("不可用"),
            multiplier: 1,
          },
        ]
      : []),
  ];
  return (
    <fieldset className="key-channel-bindings" disabled={disabled}>
      <legend>{tr("使用范围")}</legend>
      <Select
        aria-label={tr("密钥使用范围")}
        value={scope}
        onChange={(e) => setScope(e.target.value)}
        disabled={disabled || !groups}
      >
        {availableGroups.map((group) => (
          <option key={group.id} value={"group:" + group.id}>
            {group.name} · ×{group.multiplier}
          </option>
        ))}
        <option value="personal">{tr("个人渠道")}</option>
      </Select>
      <input
        type="hidden"
        name="groupId"
        value={scope.startsWith("group:") ? scope.slice(6) : ""}
      />
      {scope === "personal" && (
        <div className="key-channel-options">
          {personal.map((channel) => (
            <label className="checkbox" key={channel.id}>
              <Checkbox
                name="channelIds"
                value={channel.id}
                disabled={disabled}
                checked={selected.includes(channel.id)}
                onCheckedChange={(checked) =>
                  setSelected((current) =>
                    checked
                      ? [...current, channel.id]
                      : current.filter((id) => id !== channel.id),
                  )
                }
              />
              <span>{channel.name}</span>
            </label>
          ))}
          {!personal.length && (
            <p className="field-note">{tr("请先添加个人渠道。")}</p>
          )}
        </div>
      )}
      {scope.startsWith("group:") && (
        <p className="field-note">
          {tr("平台调用按所选分组计费，从平台余额扣除。")}
        </p>
      )}
    </fieldset>
  );
}
