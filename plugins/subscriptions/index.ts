import { definePlugin } from "@pluhub/sdk";
import { createSubscription } from "../../lib/ai/subscription.js";
import { setupSubscriptionAccounts } from "../../lib/subscriptions/accounts.js";
import { subscriptionProviders } from "../../lib/ui/subscription-providers.js";

export default definePlugin({
  async setup(host) {
    setupSubscriptionAccounts(host, subscriptionProviders);
    for (const kind of subscriptionProviders)
      await createSubscription(kind).setup(host);
  },
});
