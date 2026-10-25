import { t as tr } from "../../lib/ui/i18n.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { useLoad, Notice } from "../../lib/ui/mount.js";
import { Checkbox } from "../../lib/ui/checkbox.js";
import { Select } from "../../lib/ui/select.js";

type Group = { id: string; name: string; multiplier: number };
export function ChannelBinding({
  host,
  initialChannels = [],
  initialGroup,
  disabled = false,
}: {
  host: UIHost;
  initialChannels?: string[];
  initialGroup?: string | null;
  disabled?: boolean;
}) {
  const loaded = useLoad<{ id: string; name: string; scope: string }[]>(() =>
    host.request("/api/plugins/official.ai-router/channels"),
  );
  const groups = useLoad<Group[]>(() =>
    host.request("/api/plugins/official.ai-router/groups"),
  );
  const legacy =
    initialGroup == null &&
    initialChannels.some((id) => !id.startsWith("personal:"));
  const [scope, setScope] = React.useState(
    initialGroup
      ? "group:" + initialGroup
      : legacy
        ? "legacy"
        : initialChannels.length
          ? "personal"
          : "group:default",
  );
  const [selected, setSelected] = React.useState(initialChannels);
  const personal = [
    ...(loaded.data ?? []).filter((c) => c.scope === "personal"),
    ...initialChannels
      .filter(
        (id) =>
          id.startsWith("personal:") && !loaded.data?.some((c) => c.id === id),
      )
      .map((id) => ({
        id,
        name: id + " · " + tr("不可用"),
        scope: "personal",
      })),
  ];
  const availableGroups = [
    ...(groups.data ?? []),
    ...(initialGroup && !groups.data?.some((g) => g.id === initialGroup)
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
      <Notice message={loaded.error || groups.error} />
      <Select
        aria-label={tr("密钥使用范围")}
        value={scope}
        onChange={(e) => setScope(e.target.value)}
        disabled={disabled || !groups.data}
      >
        {availableGroups.map((group) => (
          <option key={group.id} value={"group:" + group.id}>
            {group.name} · ×{group.multiplier}
          </option>
        ))}
        <option value="personal">{tr("个人渠道 · 不扣平台余额")}</option>
        {legacy && <option value="legacy">{tr("保留原渠道授权")}</option>}
      </Select>
      <input
        type="hidden"
        name="groupId"
        value={scope.startsWith("group:") ? scope.slice(6) : ""}
      />
      {scope === "legacy" && (
        <>
          <p className="field-note">
            {tr("此密钥保留原渠道授权和计费。选择分组后将按分组设置调用。")}
          </p>
          {initialChannels.map((id) => (
            <input key={id} type="hidden" name="channelIds" value={id} />
          ))}
        </>
      )}
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
