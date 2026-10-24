import * as Popover from "@radix-ui/react-popover";
import { t as tr } from "../../lib/ui/i18n.js";
import { Icon } from "../../lib/ui/components.js";

export function ChannelActions({
  channel,
  busy,
  copy,
  graph,
  toggle,
  remove,
}: {
  channel: any;
  busy: boolean;
  copy: () => void;
  graph: () => void;
  toggle: () => void;
  remove: () => void;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button className="ghost" disabled={busy} aria-label={tr("更多操作")}>
          {tr("更多")}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="flow-add-menu" align="end" sideOffset={5}>
          {!channel.subscriptionAccountId && channel.hasCredential && (
            <Popover.Close asChild>
              <button className="ghost" onClick={copy}>
                <Icon name="copy" size={14} />
                {tr("复制上游密钥")}
              </button>
            </Popover.Close>
          )}
          <Popover.Close asChild>
            <button className="ghost" onClick={graph}>
              {tr("流程图")}
            </button>
          </Popover.Close>
          <Popover.Close asChild>
            <a
              className="button ghost"
              href={"#/auth?create=1&channel=" + encodeURIComponent(channel.id)}
            >
              {tr("绑定新密钥")}
            </a>
          </Popover.Close>
          <Popover.Close asChild>
            <button
              className="ghost"
              disabled={channel.blocked || !channel.hasCredential}
              onClick={toggle}
            >
              {tr(channel.enabled ? "停用" : "启用")}
            </button>
          </Popover.Close>
          <Popover.Close asChild>
            <button className="ghost danger" onClick={remove}>
              {tr("删除")}
            </button>
          </Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
