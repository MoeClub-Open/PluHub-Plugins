import { t as tr } from "../../lib/ui/i18n.js";
import type { UIHost } from "@pluhub/ui-sdk";
import { mountPage } from "../../lib/ui/mount.js";
import { PageHeading } from "../../lib/ui/components.js";
import { SecurityProviderForm } from "../../lib/ui/security-settings.js";
import { Keys } from "./keys-ui.js";
import { Account } from "./account-ui.js";
import { KeyAdmin } from "./admin-ui.js";
function Settings({ host }: { host: UIHost }) {
  return (
    <>
      <PageHeading title={tr("登录与注册")} />
      <SecurityProviderForm host={host} kind="auth" />
    </>
  );
}
export const mount = (element: HTMLElement, host: UIHost) =>
  mountPage(
    element,
    host,
    host.page === "/settings/access-keys"
      ? KeyAdmin
      : host.page === "/settings/auth"
        ? Settings
        : host.page === "/account"
          ? Account
          : Keys,
  );
