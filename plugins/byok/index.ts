import { SelectionPool } from "../../lib/ai/selection.js";
import { splitKeys } from "../../lib/ai/upstream-key.js";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { definePlugin, HostError } from "@pluhub/sdk";
import { openDatabase } from "../../lib/storage/sqlite.js";
import {
  channelMigration,
  moderationMigration,
  installPersonalChannels,
} from "./channels.js";
export default definePlugin({
  setup(host) {
    const file = join(host.dataDir, "vault.key");
    let master: Buffer;
    if (host.config().masterKeyRef)
      master = Buffer.from(
        host.secret(String(host.config().masterKeyRef)),
        "base64",
      );
    else {
      try {
        master = readFileSync(file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        master = randomBytes(32);
        writeFileSync(file, master, { flag: "wx", mode: 0o600 });
      }
      chmodSync(file, 0o600);
    }
    if (master.length !== 32)
      throw new HostError("invalid_config", "Vault key must be 32 bytes");
    const db = openDatabase(join(host.dataDir, "credentials.sqlite"), [
      "CREATE TABLE credentials(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,channel TEXT NOT NULL,name TEXT NOT NULL,kind TEXT NOT NULL,cipher TEXT NOT NULL,created_at INTEGER NOT NULL);",
      channelMigration,
      moderationMigration,
      "DELETE FROM credentials WHERE channel NOT LIKE 'personal:%';",
      `UPDATE personal_channels
       SET settings_json=json_remove(settings_json,'$.consumptionMode','$.consumptionMultiplier'),
           revision=revision+1
       WHERE json_type(settings_json,'$.consumptionMode') IS NOT NULL
          OR json_type(settings_json,'$.consumptionMultiplier') IS NOT NULL;`,
      "ALTER TABLE credentials ADD COLUMN key_count INTEGER NOT NULL DEFAULT 1;",
    ]);
    host.cleanup(() => {
      db.close();
      master.fill(0);
    });
    const aad = (row: any) =>
      Buffer.from(JSON.stringify([row.id, row.user_id, row.channel, row.kind]));
    function encrypt(row: any, value: unknown) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", master, iv);
      cipher.setAAD(aad(row));
      return Buffer.concat([
        iv,
        cipher.update(JSON.stringify(value)),
        cipher.final(),
        cipher.getAuthTag(),
      ]).toString("base64");
    }
    function decrypt(row: any) {
      const data = Buffer.from(row.cipher, "base64");
      const cipher = createDecipheriv(
        "aes-256-gcm",
        master,
        data.subarray(0, 12),
      );
      cipher.setAAD(aad(row));
      cipher.setAuthTag(data.subarray(-16));
      return JSON.parse(
        Buffer.concat([
          cipher.update(data.subarray(12, -16)),
          cipher.final(),
        ]).toString(),
      );
    }
    function owned(id: string, userId: string) {
      const row = db
        .prepare(
          "SELECT c.*,p.enabled,p.admin_blocked FROM credentials c JOIN personal_channels p ON p.id=c.channel AND p.user_id=c.user_id WHERE c.id=? AND c.user_id=?",
        )
        .get(id, userId) as any;
      if (!row)
        throw new HostError("credential_not_found", "渠道凭证不存在", 404);
      if (!row.enabled || row.admin_blocked)
        throw new HostError("channel_disabled", "个人渠道不存在或已停用", 403);
      return row;
    }
    const keys = new SelectionPool();
    installPersonalChannels(host, db, encrypt);
    host.provide("credentials.select@1", async ({ id, userId, channel }) => {
      const row = owned(id, userId);
      if (row.channel !== channel)
        throw new HostError(
          "credential_channel",
          "Credential is bound to a different channel",
          403,
        );
      if (row.kind === "subscription") {
        const value = decrypt(row);
        const settings = db
          .prepare(
            "SELECT settings_json FROM personal_channels WHERE id=? AND user_id=?",
          )
          .get(row.channel, userId) as any;
        if (!settings)
          throw new HostError("credential_channel", "Channel unavailable", 403);
        const protocol = JSON.parse(settings.settings_json).protocol;
        const account = await host.call<any>(`ai.subscription.${protocol}@1`, {
          action: "inspect",
          id: value.accountId,
          ownerId: userId,
        });
        if (!account.enabled)
          throw new HostError("subscription_disabled", "订阅账号已停用", 403);
      }
      return { id: row.id, kind: row.kind };
    });
    host.provide("credentials.resolve@1", async ({ id, userId, sessionId }) => {
      const row = owned(id, userId);
      if (row.kind === "subscription")
        throw new HostError("credential_kind", "订阅渠道使用订阅账号授权", 403);
      const values = splitKeys(decrypt(row).key);
      const secret = keys.choose(
        JSON.stringify([userId, id]),
        values,
        (key) => key,
        sessionId,
      );
      if (!secret) throw new HostError("credential_required", "请配置上游密钥");
      return { secret, kind: row.kind };
    });
  },
});
