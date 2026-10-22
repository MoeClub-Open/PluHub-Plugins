import { t as tr } from "../../lib/ui/i18n.js";
import { Select } from "../../lib/ui/select.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { useLoad, Notice } from "../../lib/ui/mount.js";
export function ChannelBinding({
  host,
  initialChannel = "",
}: {
  host: UIHost;
  initialChannel?: string;
}) {
  const channels = useLoad<any[]>(() =>
    host.request("/api/plugins/official.ai-router/channels"),
  );
  const [channel, setChannel] = React.useState(initialChannel);
  return (
    <>
      <Notice message={channels.error} />
      <label>
        {tr("绑定渠道")}
        <Select
          name="channelId"
          value={channel}
          onChange={(e) => {
            setChannel(e.target.value);
          }}
        >
          <option value="">{tr("平台默认路由")}</option>
          {initialChannel &&
            !channels.data?.some((c) => c.id === initialChannel) && (
              <option value={initialChannel}>
                {tr("原绑定（不可用，请更换）")}
              </option>
            )}
          <optgroup label={tr("个人渠道")}>
            {channels.data
              ?.filter((c) => c.scope === "personal")
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </optgroup>
          <optgroup label={tr("平台渠道")}>
            {channels.data
              ?.filter((c) => c.scope === "platform")
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </optgroup>
        </Select>
      </label>
    </>
  );
}
