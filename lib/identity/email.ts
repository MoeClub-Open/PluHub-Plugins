import { HostError } from "@pluhub/sdk";

export function emailAddress(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,63}$/.test(
      value,
    )
  )
    throw new HostError("invalid_email", "Enter a valid email address");
  return value.toLowerCase();
}
