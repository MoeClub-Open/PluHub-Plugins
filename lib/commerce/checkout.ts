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
  currencies: PaymentProviderStatus["currencies"];
  modes: PaymentProviderStatus["modes"];
  renewal: PaymentProviderStatus["renewal"];
}
export function checkoutMethods(
  provider: string,
  status: PaymentProviderStatus,
): CheckoutMethod[] {
  if (!status.enabled) return [];
  return status.methods.map((method) => ({
    ...method,
    provider,
    currencies: status.currencies,
    modes: status.modes,
    renewal: status.renewal,
  }));
}
export const checkoutMethodKey = (method: CheckoutMethod) =>
  JSON.stringify([method.provider, method.id ?? null]);
export function supportsCheckout(
  status: Pick<PaymentProviderStatus, "currencies" | "modes"> | undefined,
  currency: string,
  mode: "payment" | "subscription",
) {
  return (
    !!status &&
    status.modes.includes(mode) &&
    (status.currencies === "*" || status.currencies.includes(currency))
  );
}
