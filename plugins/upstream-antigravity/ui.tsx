import type { UIHost } from "@pluhub/ui-sdk";
import { mountPage } from "../../lib/ui/mount.js";
import { SubscriptionAccounts } from "../../lib/ui/subscription-accounts.js";
export const mount = (element: HTMLElement, host: UIHost) =>
  mountPage(element, host, ({ host }) => (
    <SubscriptionAccounts host={host} provider="antigravity" />
  ));
