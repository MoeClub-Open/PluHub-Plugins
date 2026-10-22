import type { UIHost, Extension } from "@pluhub/ui-sdk";
import type { SubscriptionKind } from "../ai/subscription-auth.js";
export const subscriptionProviders: SubscriptionKind[] = [
  "codex",
  "claude-subscription",
  "antigravity",
];
export const subscriptionApi = (provider: SubscriptionKind) =>
  "/api/plugins/official.upstream-" + provider;
export async function installedSubscriptionProviders(host: UIHost) {
  const extensions = await host.request<Extension[]>("/api/host/extensions");
  return subscriptionProviders.filter((provider) =>
    extensions.some((e) => e.id === "official.upstream-" + provider),
  );
}
export async function listSubscriptionAccounts(host: UIHost, personal = false) {
  const providers = await installedSubscriptionProviders(host);
  const results = await Promise.allSettled(
    providers.map((provider) =>
      host.request<any[]>(
        subscriptionApi(provider) +
          (personal ? "/personal" : "") +
          "/accounts",
      ),
    ),
  );
  const accounts = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  const firstError = results.find(
    (result) => result.status === "rejected",
  );
  if (!accounts.length && firstError?.status === "rejected")
    throw firstError.reason;
  return accounts;
}
