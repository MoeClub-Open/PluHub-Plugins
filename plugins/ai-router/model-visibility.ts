import type { ModelRoute } from "@pluhub/contracts/ai";
import type { BillingCustomerStatus } from "@pluhub/contracts/commerce";

export function modelVisible(
  model: ModelRoute,
  userId?: string,
  status?: BillingCustomerStatus,
) {
  switch (model.visibility) {
    case "authenticated":
      return !!userId;
    case "consumed":
      return !!userId && status?.consumed === true;
    case "paid":
      return !!userId && status?.paid === true;
    default:
      return true;
  }
}
