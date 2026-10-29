import type { Upstream } from "@pluhub/contracts/ai";

export type ChannelPanel = "routing";

/** Old bookmarks resolve into the editor without creating a second settings page. */
export function channelEditorTarget(
  page: string,
  channels: Record<string, Upstream>,
) {
  const query = new URLSearchParams(page.split("?")[1]);
  const panel =
    query.get("panel") === "routing" || query.get("tab") === "policies"
        ? "routing"
        : undefined;
  const requested = query.get("channel");
  const channelId =
    requested ??
    (panel === "routing"
      ? Object.keys(channels).find((id) =>
          channels[id]?.flow?.nodes.some((node) => node.type === "routing"),
        )
      : undefined) ??
    (panel ? Object.keys(channels)[0] : undefined);
  return channelId && Object.hasOwn(channels, channelId)
    ? { channelId, panel: panel as ChannelPanel | undefined }
    : undefined;
}
