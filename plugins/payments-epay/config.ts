import { HostError } from "@pluhub/sdk";

export const paymentTypes = ["alipay", "wxpay", "qqpay"] as const;
export type EpayMethod = {
  id: string;
  name?: string;
  enabled?: boolean;
  version: "v1" | "v2";
  algorithm: "MD5" | "RSA";
  pid: string;
  baseUrl: string;
  publicUrl: string;
  paymentType: (typeof paymentTypes)[number];
  clientIp?: string;
  keyRef?: string;
  privateKeyRef?: string;
  platformPublicKeyRef?: string;
};
export type EpayConfig = Partial<EpayMethod> & {
  methods?: EpayMethod[];
  secretRefs?: string[];
};
export function epayMethods(config: EpayConfig): EpayMethod[] {
  return (
    config.methods ??
    (config.pid || config.enabled
      ? [
          {
            ...config,
            id: "default",
            paymentType: config.paymentType ?? "alipay",
          } as EpayMethod,
        ]
      : [])
  );
}
export function validateEpayConfig(config: EpayConfig) {
  const ids = new Set<string>();
  for (const method of epayMethods(config)) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(method.id) || ids.has(method.id))
      throw new HostError(
        "invalid_config",
        "Invalid or duplicate Epay method ID",
      );
    ids.add(method.id);
    if (!method.enabled) continue;
    for (const field of [
      "version",
      "algorithm",
      "pid",
      "baseUrl",
      "publicUrl",
      ...(method.algorithm === "RSA"
        ? ["privateKeyRef", "platformPublicKeyRef"]
        : ["keyRef"]),
    ] as (keyof EpayMethod)[])
      if (typeof method[field] !== "string" || !method[field])
        throw new HostError("invalid_config", "Missing Epay " + field);
    for (const field of ["baseUrl", "publicUrl"] as const) {
      const url = new URL(method[field]);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new HostError("invalid_config", "Invalid Epay " + field);
    }
  }
}
