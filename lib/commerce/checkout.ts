export const paymentLabels: Record<string, string> = {
  stripe: "Stripe",
  epay: "易支付",
};
export function supportsCheckout(provider: string, currency: string) {
  return provider === "stripe" || (provider === "epay" && currency === "cny");
}
