import { t as tr, textValue } from "../../lib/ui/i18n.js";
import { Select } from "../../lib/ui/select.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { useLoad, Notice } from "../../lib/ui/mount.js";
export function ChannelBinding({
  host,
  initialChannel = "",
  initialCredential = "",
}: {
  host: UIHost;
  initialChannel?: string;
  initialCredential?: string;
}) {
  const channels = useLoad<any[]>(() =>
    host.request("/api/plugins/official.ai-router/channels"),
  );
  const credentials = useLoad<any[]>(() =>
    host.request("/api/plugins/official.byok/credentials").catch(() => []),
  );
  const [channel, setChannel] = React.useState(initialChannel);
  const [credential, setCredential] = React.useState(initialCredential);
  const personal = channel.startsWith("personal:");
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
            setCredential("");
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
      {!personal && channel && (
        <label>
          {tr("调用凭证")}
          <Select
            name="credentialId"
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
          >
            <option value="">{tr("平台凭证（按平台规则计费）")}</option>
            {initialCredential &&
              !credentials.data?.some((c) => c.id === initialCredential) && (
                <option value={initialCredential}>
                  {tr("原凭证（已不可用）")}
                </option>
              )}
            {credentials.data
              ?.filter((c) => c.channel === channel)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {tr("{0} · 自带凭证", { "0": textValue(c.name) })}
                </option>
              ))}
          </Select>
        </label>
      )}
      <p className="field-note">
        {tr("仅可调用绑定渠道的模型。")}
        <a href="#/byok">{tr("管理个人渠道")}</a>
      </p>
    </>
  );
}
