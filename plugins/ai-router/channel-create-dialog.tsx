import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import type { ModelRoute, Upstream } from "@pluhub/contracts/ai";
import { t as tr } from "../../lib/ui/i18n.js";
import { Dialog } from "../../lib/ui/components.js";
import { Notice } from "../../lib/ui/mount.js";
import { defaultChannelFlow } from "../../lib/ai/channel-config.js";
import { nextNumericId } from "../../lib/numeric-id.js";

type Router = {
  upstreams: Record<string, Upstream>;
  models: Record<string, ModelRoute>;
  nextChannelId?: string;
};

export function ChannelCreateDialog({
  channelId,
  existing,
  busy,
  save,
  openGraph,
  close,
}: {
  host: UIHost;
  channelId: string;
  existing?: Upstream;
  busy: boolean;
  save: (update: (router: Router) => void) => Promise<void>;
  openGraph: (id: string) => void;
  close: () => void;
}) {
  const [error, setError] = React.useState("");
  return (
    <Dialog title={tr(existing ? "编辑渠道" : "添加渠道")} close={close}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          let id = channelId;
          try {
            await save((router) => {
              if (!existing) {
                id = nextNumericId(
                  Object.keys(router.upstreams),
                  router.nextChannelId,
                );
                router.nextChannelId = String(BigInt(id) + 1n);
              }
              router.upstreams[id] = {
                ...existing,
                name: String(form.get("name")).trim(),
                priority: Number(form.get("priority")),
                enabled: existing?.enabled ?? false,
                flow: existing?.flow ?? defaultChannelFlow(),
              };
            });
            if (!existing) openGraph(id);
          } catch (error) {
            setError((error as Error).message);
          }
        }}
      >
        <Notice message={error} />
        <div className="form-grid">
          <label>
            {tr("渠道名称")}
            <input
              name="name"
              required
              maxLength={128}
              defaultValue={existing?.name ?? ""}
            />
          </label>
          <label>
            {tr("优先级")}
            <input
              name="priority"
              type="number"
              step="1"
              defaultValue={existing?.priority ?? 0}
            />
          </label>
        </div>
        <div className="form-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={close}
          >
            {tr("取消")}
          </button>
          <button disabled={busy}>
            {tr(existing ? "保存" : "创建并编辑流程")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
