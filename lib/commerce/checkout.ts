import type { PaymentProviderStatus } from "@pluhub/contracts/commerce";

export const paymentLabels: Record<string, string> = {
  stripe: "Stripe",
  epay: "易支付",
  alipay: "支付宝",
  wxpay: "微信支付",
  qqpay: "QQ 钱包",
};
export interface CheckoutMethod {
  provider: string;
  id?: string;
  name: string;
  type?: string;
}
export function checkoutMethods(
  provider: string,
  status: PaymentProviderStatus,
): CheckoutMethod[] {
  if (!status.enabled) return [];
  return status.methods
    ? status.methods.map((method) => ({ ...method, provider }))
    : [{ provider, name: provider }];
}
export const checkoutMethodKey = (method: CheckoutMethod) =>
  JSON.stringify([method.provider, method.id ?? null]);
export function supportsCheckout(provider: string, currency: string) {
  return provider === "stripe" || (provider === "epay" && currency === "cny");
}
