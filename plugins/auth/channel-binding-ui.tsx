import { t as tr } from "../../lib/ui/i18n.js";
import React from "react";
import { Checkbox } from "../../lib/ui/checkbox.js";

export type KeyChannel = {
  id: string;
  name: string;
  scope: string;
  consumptionMultiplier?: number;
};
export function ChannelBinding({
  channels,
  initialChannels = [],
  disabled = false,
}: {
  channels: KeyChannel[];
  initialChannels?: string[];
  disabled?: boolean;
}) {
  const [selected, setSelected] = React.useState(initialChannels);
  const options = [
    ...channels,
    ...initialChannels
      .filter((id) => !channels.some((channel) => channel.id === id))
      .map((id) => ({
        id,
        name: id + " · " + tr("不可用"),
        scope: id.startsWith("personal:") ? "personal" : "platform",
      })),
  ];
  return (
    <fieldset className="key-channel-bindings" disabled={disabled}>
      <legend>{tr("渠道范围")}</legend>
      <div className="key-channel-options">
        {options.map((channel) => (
          <label className="checkbox" key={channel.id}>
            <Checkbox
              name="channelIds"
              value={channel.id}
              checked={selected.includes(channel.id)}
              onCheckedChange={(checked) =>
                setSelected((current) =>
                  checked
                    ? [...current, channel.id]
                    : current.filter((id) => id !== channel.id),
                )
              }
            />
            <span>
              {channel.scope === "personal" ? tr("个人 · ") : tr("平台 · ")}
              {channel.name}
            </span>
          </label>
        ))}
      </div>
      <p className="field-note">{tr("未选择时使用全部平台渠道。")}</p>
    </fieldset>
  );
}
