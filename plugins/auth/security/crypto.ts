import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { HostError } from "@pluhub/sdk";
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32(bytes: Uint8Array) {
  let bits = 0,
    value = 0,
    result = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      result += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}
function unbase32(text: string) {
  let bits = 0,
    value = 0;
  const out = [];
  for (const ch of text.toUpperCase().replace(/=+$/, "")) {
    const n = alphabet.indexOf(ch);
    if (n < 0) throw new Error("Invalid base32");
    value = (value << 5) | n;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
export function totp(secret: string, counter: number, digits = 6) {
  const moving = Buffer.alloc(8);
  moving.writeBigUInt64BE(BigInt(counter));
  const hash = createHmac("sha1", unbase32(secret)).update(moving).digest();
  const offset = hash[hash.length - 1]! & 15;
  return ((hash.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits)
    .toString()
    .padStart(digits, "0");
}
export function matchTotp(
  secret: string,
  code: unknown,
  last: number,
  now = Date.now(),
): number | undefined {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return;
  const counter = Math.floor(now / 30000);
  for (const step of [0, -1, 1]) {
    const c = counter + step;
    if (
      c > last &&
      c >= 0 &&
      timingSafeEqual(Buffer.from(totp(secret, c)), Buffer.from(code))
    )
      return c;
  }
}
export function authVault(directory: string, requireExisting = false) {
  const file = join(directory, "security.key");
  let key: Buffer;
  try {
    key = readFileSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    if (requireExisting)
      throw new HostError(
        "invalid_config",
        "Authentication encryption key is missing; restore security.key from backup",
      );
    key = randomBytes(32);
    writeFileSync(file, key, { flag: "wx", mode: 0o600 });
  }
  chmodSync(file, 0o600);
  if (key.length !== 32)
    throw new HostError(
      "invalid_config",
      "Invalid authentication encryption key",
    );
  return {
    close: () => {
      key.fill(0);
    },
    hash: (value: string) =>
      createHmac("sha256", key).update(value).digest("hex"),
    encrypt: (value: string, aad: string) => {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(aad));
      return Buffer.concat([
        iv,
        cipher.update(value, "utf8"),
        cipher.final(),
        cipher.getAuthTag(),
      ]).toString("base64");
    },
    decrypt: (value: string, aad: string) => {
      const bytes = Buffer.from(value, "base64"),
        cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      cipher.setAAD(Buffer.from(aad));
      cipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([
        cipher.update(bytes.subarray(12, -16)),
        cipher.final(),
      ]).toString("utf8");
    },
  };
}
