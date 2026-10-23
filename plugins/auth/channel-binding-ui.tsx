import { t as tr } from "../../lib/ui/i18n.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { useLoad, Notice } from "../../lib/ui/mount.js";
import { Checkbox } from "../../lib/ui/checkbox.js";

export function ChannelBinding({
  host,
  initialChannels = [],
  disabled = false,
}: {
  host: UIHost;
  initialChannels?: string[];
  disabled?: boolean;
}) {
  const loaded = useLoad<
    {
      id: string;
      name: string;
      scope: string;
      consumptionMultiplier?: number;
    }[]
  >(() => host.request("/api/plugins/official.ai-router/channels"));
  const [selected, setSelected] = React.useState(initialChannels);
  const channels = [
    ...(loaded.data ?? []),
    ...initialChannels
      .filter((id) => !loaded.data?.some((channel) => channel.id === id))
      .map((id) => ({
        id,
        name: id,
        scope: "unavailable",
        consumptionMultiplier: undefined,
      })),
  ];
  return (
    <fieldset className="key-channel-bindings" disabled={disabled}>
      <legend>{tr("绑定渠道")}</legend>
      <Notice message={loaded.error} />
      <div className="key-channel-options">
        <label className="checkbox">
          <Checkbox
            disabled={disabled}
            checked={!selected.length}
            onCheckedChange={() => setSelected([])}
          />
          <span>{tr("平台默认路由")}</span>
        </label>
        {channels.map((channel) => (
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
            <span title={channel.name}>
              {channel.name}
              {channel.scope === "personal" ? " · " + tr("个人渠道") : ""}
              {channel.scope === "unavailable"
                ? " · " + tr("不可用")
                : " · ×" + (channel.consumptionMultiplier ?? 1)}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
