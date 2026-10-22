import React from "react";
import type { Extension, UIHost, UIExtensionModule } from "@pluhub/ui-sdk";
import { t as tr } from "./i18n.js";

/** Load settings through the public UI extension contract. */
export function ChannelExtension({
  host,
  path,
  query = "",
}: {
  host: UIHost;
  path: string;
  query?: string;
}) {
  const target = React.useRef<HTMLDivElement>(null);
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    let canceled = false;
    let dispose: (() => void) | undefined;
    setError("");
    void host
      .request<Extension[]>("/api/host/extensions")
      .then(async (extensions) => {
        const extension = extensions.find((e) => !e.public && e.path === path);
        if (!extension) throw new Error(tr("请先安装并启用对应插件"));
        const mod = (await import(extension.url)) as UIExtensionModule;
        if (!canceled && target.current)
          dispose = mod.mount(target.current, {
            ...host,
            page: path + query,
            slot: "channel.settings",
          });
      })
      .catch((e) => {
        if (!canceled) setError(e.message);
      });
    return () => {
      canceled = true;
      dispose?.();
    };
  }, [host, path, query]);
  return (
    <>
      {error && <p role="alert">{error}</p>}
      <div ref={target} />
    </>
  );
}
