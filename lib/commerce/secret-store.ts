import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  HostError,
  json,
  readObject,
  requiredString,
  type Host,
} from "@pluhub/sdk";
import { requireAdmin } from "../admin/access.js";
import { openDatabase, transaction } from "../storage/sqlite.js";

const localReference = /^local:[a-f0-9-]{36}$/;

export function paymentSecretStore<T extends string>(
  host: Host,
  secretFields: readonly T[],
) {
  const file = join(host.dataDir, "vault.key");
  let master: Buffer;
  try {
    master = readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    master = randomBytes(32);
    writeFileSync(file, master, { flag: "wx", mode: 0o600 });
  }
  chmodSync(file, 0o600);
  if (master.length !== 32)
    throw new HostError("invalid_secret", "支付密钥存储不可用", 503);
  const db = openDatabase(join(host.dataDir, "secrets.sqlite"), [
    "CREATE TABLE secrets(reference TEXT PRIMARY KEY,kind TEXT NOT NULL,cipher TEXT NOT NULL);",
  ]);
  host.cleanup(() => {
    db.close();
    master.fill(0);
  });
  const aad = (reference: string, kind: T) =>
    Buffer.from(JSON.stringify([reference, kind]));
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
      const data = Buffer.from(row.cipher, "base64");
      const cipher = createDecipheriv(
        "aes-256-gcm",
        master,
        data.subarray(0, 12),
      );
      cipher.setAAD(aad(reference, kind));
      cipher.setAuthTag(data.subarray(-16));
      return Buffer.concat([
        cipher.update(data.subarray(12, -16)),
        cipher.final(),
      ]).toString("utf8");
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
          const iv = randomBytes(12);
          const cipher = createCipheriv("aes-256-gcm", master, iv);
          cipher.setAAD(aad(reference, kind));
          const encrypted = Buffer.concat([
            iv,
            cipher.update(value),
            cipher.final(),
            cipher.getAuthTag(),
          ]);
          db.prepare("INSERT INTO secrets VALUES(?,?,?)").run(
            reference,
            kind,
            encrypted.toString("base64"),
          );
          references[kind] = reference;
        }
      });
      return json(references);
    },
  });
  return { read };
}
