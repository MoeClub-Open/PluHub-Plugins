import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  HostError,
  json,
  readObject,
  requiredString,
  type Host,
} from "@pluhub/sdk";
import { requireAdmin } from "../admin/access.js";
import { openVault } from "../security/vault.js";
import { openDatabase, transaction } from "../storage/sqlite.js";

const localReference = /^local:[a-f0-9-]{36}$/;

export function paymentSecretStore<T extends string>(
  host: Host,
  secretFields: readonly T[],
) {
  const vault = openVault({
    directory: host.dataDir,
    errorCode: "invalid_secret",
    invalidMessage: "支付密钥存储不可用",
    errorStatus: 503,
  });
  const db = openDatabase(join(host.dataDir, "secrets.sqlite"), [
    "CREATE TABLE secrets(reference TEXT PRIMARY KEY,kind TEXT NOT NULL,cipher TEXT NOT NULL);",
  ]);
  host.cleanup(() => {
    db.close();
    vault.close();
  });
  const aad = (reference: string, kind: T) =>
    JSON.stringify([reference, kind]);
  function read(reference: string, kind: T) {
    if (reference.startsWith("secret:") || reference.startsWith("env:"))
      return host.secret(reference);
    const row = localReference.test(reference)
      ? (db
          .prepare("SELECT cipher FROM secrets WHERE reference=? AND kind=?")
          .get(reference, kind) as { cipher: string } | undefined)
      : undefined;
    if (!row)
      throw new HostError("secret_missing", "支付密钥不存在，请重新填写", 409);
    try {
      return vault.decryptText(row.cipher, aad(reference, kind));
    } catch {
      throw new HostError("invalid_secret", "支付密钥存储不可用", 503);
    }
  }
  host.api({
    method: "POST",
    path: "/secrets",
    access: "host.manage",
    async handle(request, ctx) {
      await requireAdmin(host, request, ctx);
      const body = await readObject(request);
      const values = secretFields
        .filter((kind) => body[kind] !== undefined)
        .map((kind) => ({
          kind,
          value: requiredString(body[kind], kind, 32768),
        }));
      const references: Partial<Record<T, string>> = {};
      transaction(db, () => {
        for (const { kind, value } of values) {
          const reference = "local:" + randomUUID();
          db.prepare("INSERT INTO secrets VALUES(?,?,?)").run(
            reference,
            kind,
            vault.encryptText(value, aad(reference, kind)),
          );
          references[kind] = reference;
        }
      });
      return json(references);
    },
  });
  return { read };
}
