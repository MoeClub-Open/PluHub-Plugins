import { SelectionPool } from "../../lib/ai/selection.js";
import { splitKeys } from "../../lib/ai/upstream-key.js";
import { join } from "node:path";
import {
  definePlugin,
  HostError,
  json,
  readObject,
  requiredString,
} from "@pluhub/sdk";
import { openPluginVault } from "../../lib/security/vault.js";
import { openDatabase } from "../../lib/storage/sqlite.js";
import {
  channelMigration,
  moderationMigration,
  installPersonalChannels,
} from "./channels.js";
export default definePlugin({
  setup(host) {
    const vault = openPluginVault(host);
    const db = openDatabase(join(host.dataDir, "credentials.sqlite"), [
      "CREATE TABLE credentials(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,channel TEXT NOT NULL,name TEXT NOT NULL,kind TEXT NOT NULL,cipher TEXT NOT NULL,created_at INTEGER NOT NULL);",
      channelMigration,
      moderationMigration,
      "DELETE FROM credentials WHERE channel NOT LIKE 'personal:%';",
      "SELECT 1;",
      "ALTER TABLE credentials ADD COLUMN key_count INTEGER NOT NULL DEFAULT 1;",
    ]);
    host.cleanup(() => {
      db.close();
      vault.close();
    });
    const aad = (row: any) =>
      JSON.stringify([row.id, row.user_id, row.channel, row.kind]);
    function encrypt(row: any, value: unknown) {
      return vault.encryptJson(value, aad(row));
    }
    function decrypt(row: any) {
      return vault.decryptJson(row.cipher, aad(row));
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
    host.api({
      method: "POST",
      path: "/personal-channels/keys",
      access: "authenticated",
      async handle(request, ctx) {
        if (!ctx.principal?.session)
          throw new HostError("session_required", "请登录后管理个人渠道", 403);
        const body = await readObject(request);
        const row = db
          .prepare("SELECT * FROM credentials WHERE id=? AND user_id=?")
          .get(requiredString(body.id, "id"), ctx.principal.id) as any;
        if (!row || row.kind !== "key")
          throw new HostError("credential_not_found", "渠道凭证不存在", 404);
        const response = json({ keys: splitKeys(decrypt(row).key) });
        response.headers.set("cache-control", "private, no-store");
        return response;
      },
    });
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
