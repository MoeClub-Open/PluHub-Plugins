import { HostError } from "@pluhub/sdk";
export function integer(value: unknown, name = "amount", min = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < min)
    throw new HostError("invalid_amount", "Invalid integer " + name);
  return Number(value);
}
export function minorAmount(value: string): number {
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(value))
    throw new HostError("invalid_amount", "Invalid payment amount");
  const [whole, cents = ""] = value.split(".");
  return integer(Number(whole) * 100 + Number(cents.padEnd(2, "0")));
}
export const decimalAmount = (minor: number) =>
  (integer(minor) / 100).toFixed(2);
