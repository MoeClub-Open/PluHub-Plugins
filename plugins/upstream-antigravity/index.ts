import { createSubscription } from "../../lib/ai/subscription.js";
import { setupSubscriptionAccounts } from "../../lib/subscriptions/accounts.js";
import { definePlugin } from "@pluhub/sdk";
export default definePlugin({
  async setup(host) {
    setupSubscriptionAccounts(host, "antigravity");
    await createSubscription("antigravity").setup(host);
  },
});
