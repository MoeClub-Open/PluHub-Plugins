import type { UIHost } from "@pluhub/ui-sdk";
import { mountPage } from "../../lib/ui/mount.js";
import { PageHeading } from "../../lib/ui/components.js";
import { t as tr } from "../../lib/ui/i18n.js";
import { SubscriptionAccounts } from "../../lib/ui/subscription-accounts.js";

function Page({ host }: { host: UIHost }) {
  return (
    <>
      <PageHeading title={tr("订阅账号")} />
      <SubscriptionAccounts host={host} />
    </>
  );
}

export const mount = (element: HTMLElement, host: UIHost) =>
  mountPage(element, host, Page);
