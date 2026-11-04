import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HostError, type Host } from "@pluhub/sdk";

export interface VaultOptions {
  directory: string;
  file?: string;
  masterKeyRef?: unknown;
  resolveSecret?: (reference: string) => string;
  requireExisting?: boolean;
  missingMessage?: string;
  errorCode?: string;
  invalidMessage?: string;
  errorStatus?: number;
}

export function openVault(options: VaultOptions) {
  const errorCode = options.errorCode ?? "invalid_config";
  const invalidMessage = options.invalidMessage ?? "Vault key must be 32 bytes";
  const status = options.errorStatus ?? 400;
  let key: Buffer;
  if (options.masterKeyRef) {
    key = Buffer.from(
      options.resolveSecret!(String(options.masterKeyRef)),
      "base64",
    );
  } else {
    const path = join(options.directory, options.file ?? "vault.key");
    try {
      key = readFileSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (options.requireExisting) {
        throw new HostError(
          errorCode,
          options.missingMessage ?? "Vault key is missing; restore from backup",
          status,
        );
      }
      key = randomBytes(32);
      writeFileSync(path, key, { flag: "wx", mode: 0o600 });
    }
    chmodSync(path, 0o600);
  }
  if (key.length !== 32) {
    throw new HostError(errorCode, invalidMessage, status);
  }
  const toBuffer = (aad: string | Uint8Array) =>
    typeof aad === "string" ? Buffer.from(aad) : aad;
  return {
    close: () => {
      key.fill(0);
    },
    hash: (value: string) =>
      createHmac("sha256", key).update(value).digest("hex"),
    encryptText: (value: string, aad: string | Uint8Array) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(toBuffer(aad));
      return Buffer.concat([
        iv,
        cipher.update(value, "utf8"),
        cipher.final(),
        cipher.getAuthTag(),
      ]).toString("base64");
    },
    decryptText: (value: string, aad: string | Uint8Array) => {
      const bytes = Buffer.from(value, "base64");
      const cipher = createDecipheriv(
        "aes-256-gcm",
        key,
        bytes.subarray(0, 12),
      );
      cipher.setAAD(toBuffer(aad));
      cipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([
        cipher.update(bytes.subarray(12, -16)),
        cipher.final(),
      ]).toString("utf8");
    },
    encryptJson: (value: unknown, aad: string | Uint8Array) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(toBuffer(aad));
      return Buffer.concat([
        iv,
        cipher.update(JSON.stringify(value), "utf8"),
        cipher.final(),
        cipher.getAuthTag(),
      ]).toString("base64");
    },
    decryptJson: <T = any>(value: string, aad: string | Uint8Array): T => {
      const bytes = Buffer.from(value, "base64");
      const cipher = createDecipheriv(
        "aes-256-gcm",
        key,
        bytes.subarray(0, 12),
      );
      cipher.setAAD(toBuffer(aad));
      cipher.setAuthTag(bytes.subarray(-16));
      return JSON.parse(
        Buffer.concat([
          cipher.update(bytes.subarray(12, -16)),
          cipher.final(),
        ]).toString("utf8"),
      );
    },
  };
}

export function openPluginVault(host: Host) {
  return openVault({
    directory: host.dataDir,
    masterKeyRef: host.config().masterKeyRef,
    resolveSecret: (reference) => host.secret(reference),
  });
}
