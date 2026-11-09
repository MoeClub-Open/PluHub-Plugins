import type {
  PaymentProviderStatus,
  Product,
} from "@pluhub/contracts/commerce";
import { decimal, multiply } from "./decimal.js";
import { integer } from "./money.js";

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
  conversion?: PaymentProviderStatus["conversion"];
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
    conversion: status.conversion,
  }));
}
export const checkoutMethodKey = (method: CheckoutMethod) =>
  JSON.stringify([method.provider, method.id ?? null]);
export function checkoutProduct(
  status: Pick<PaymentProviderStatus, "conversion"> | undefined,
  product: Product,
): Product {
  const conversion = status?.conversion;
  if (!conversion || product.currency !== conversion.from) return product;
  const amount = multiply(
    decimal(product.paymentMinor),
    decimal(conversion.rate),
  );
  return {
    ...product,
    currency: conversion.to,
    paymentMinor: integer(
      Number((amount.n * 2n + amount.d) / (amount.d * 2n)),
      "converted payment amount",
      1,
    ),
  };
}
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
