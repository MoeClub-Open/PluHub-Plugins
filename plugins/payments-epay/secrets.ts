import type { Host } from "@pluhub/sdk";
import { paymentSecretStore } from "../../lib/commerce/secret-store.js";
export const secretFields = [
  "keyRef",
  "privateKeyRef",
  "platformPublicKeyRef",
] as const;
export type SecretField = (typeof secretFields)[number];
export type PaymentSecrets = Partial<Record<SecretField, string>>;
export const epaySecrets = (host: Host) =>
  paymentSecretStore(host, secretFields);
