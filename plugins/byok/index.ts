import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import {
  definePlugin,
  HostError,
  json,
  readObject,
  requiredString,
} from "@pluhub/sdk";
import { openDatabase } from "../../lib/storage/sqlite.js";
import { waitFor } from "../../lib/ai/cancellation.js";
import { responseObject } from "../../lib/ai/json-response.js";
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
    ]);
    const stop = new AbortController();
    const refreshing = new Map<string, Promise<any>>();
    host.cleanup(async () => {
      stop.abort();
      await Promise.allSettled([...refreshing.values()]);
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
        .prepare("SELECT * FROM credentials WHERE id=? AND user_id=?")
        .get(id, userId) as any;
      if (!row)
        throw new HostError(
          "credential_not_found",
          "Credential not found",
          404,
        );
      if (row.channel.startsWith("personal:")) {
        const channel = db
          .prepare(
            "SELECT enabled,admin_blocked FROM personal_channels WHERE id=? AND user_id=?",
          )
          .get(row.channel, userId) as any;
        if (!channel?.enabled || channel.admin_blocked)
          throw new HostError(
            "channel_disabled",
            "个人渠道不存在或已停用",
            403,
          );
      }
      return row;
    }
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
    async function resolve(row: any, signal: AbortSignal) {
      let value = decrypt(row);
      let currentCipher = row.cipher;
      if (
        row.kind === "oauth" &&
        value.expires_at &&
        Number(value.expires_at) <= Date.now() + 60000
      ) {
        const c = (host.config().oauth ?? {}) as Record<string, any>;
        const cfg = c[row.channel];
        if (!cfg || !value.refresh_token)
          throw new HostError(
            "credential_expired",
            "OAuth credential expired; import a fresh authorization",
            401,
          );
        const form = new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: value.refresh_token,
          client_id: cfg.clientId,
        });
        if (cfg.clientSecretRef)
          form.set("client_secret", host.secret(cfg.clientSecretRef));
        const endpoint = new URL(cfg.tokenUrl);
        if (
          endpoint.protocol !== "https:" ||
          endpoint.username ||
          endpoint.password
        )
          throw new HostError(
            "invalid_config",
            "OAuth token endpoint must use HTTPS",
          );
        const response = await host.call<Response>(
          "http.transport@1",
          {
            url: endpoint.href,
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: form.toString(),
            publicOnly: true,
          },
          signal,
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new HostError(
            "oauth_refresh_failed",
            "Upstream authorization refresh failed",
            502,
          );
        }
        const next = await responseObject(response, signal);
        if (
          typeof next.access_token !== "string" ||
          !Number.isFinite(next.expires_in) ||
          next.expires_in <= 0
        )
          throw new HostError(
            "oauth_refresh_failed",
            "Invalid token refresh response",
            502,
          );
        requiredString(next.access_token, "access_token", 32768);
        if (next.refresh_token !== undefined)
          requiredString(next.refresh_token, "refresh_token", 32768);
        value = {
          ...value,
          access_token: next.access_token,
          refresh_token: next.refresh_token ?? value.refresh_token,
          expires_at: Date.now() + next.expires_in * 1000,
        };
        currentCipher = encrypt(row, value);
        const updated = db
          .prepare(
            "UPDATE credentials SET cipher=? WHERE id=? AND user_id=? AND cipher=?",
          )
          .run(currentCipher, row.id, row.user_id, row.cipher);
        if (!updated.changes) {
          owned(row.id, row.user_id);
          throw new HostError("credential_changed", "凭证已更改，请重试", 409);
        }
      }
      return {
        secret: row.kind === "oauth" ? value.access_token : value.key,
        kind: row.kind,
        accountId: value.account_id,
        projectId: value.project_id,
        currentCipher,
      };
    }
    host.provide("credentials.resolve@1", async ({ id, userId }, signal) => {
      const row = owned(id, userId);
      if (row.kind === "subscription")
        throw new HostError(
          "credential_kind",
          "订阅渠道必须通过订阅账号占用调用",
          403,
        );
      const cacheKey = id + "\0" + row.cipher;
      let work = refreshing.get(cacheKey);
      if (!work) {
        work = resolve(
          row,
          AbortSignal.any([stop.signal, AbortSignal.timeout(30000)]),
        ).finally(() => refreshing.delete(cacheKey));
        refreshing.set(cacheKey, work);
      }
      const { currentCipher, ...credential } = await waitFor(work, signal);
      if (owned(id, userId).cipher !== currentCipher)
        throw new HostError("credential_changed", "凭证已更改，请重试", 409);
      return credential;
    });
    async function credentialChannels() {
      const channels =
        await host.call<{ id: string; name: string; protocol: string }[]>(
          "ai.channels@1",
        );
      return channels.filter(
        (channel) =>
          !!channel.protocol &&
          !["auto-router", "workflow"].includes(channel.protocol),
      );
    }
    host.api({
      method: "GET",
      path: "/channels",
      access: "authenticated",
      handle: async () => json(await credentialChannels()),
    });
    host.api({
      method: "GET",
      path: "/credentials",
      access: "authenticated",
      handle: (_r, ctx) =>
        json(
          db
            .prepare(
              "SELECT id,channel,name,kind,created_at FROM credentials WHERE user_id=? ORDER BY created_at DESC",
            )
            .all(ctx.principal!.id),
        ),
    });
    host.api({
      method: "POST",
      path: "/credentials",
      access: "authenticated",
      handle: async (r, ctx) => {
        if (!ctx.principal?.session)
          throw new HostError(
            "session_required",
            "Console session required",
            403,
          );
        const b = await readObject(r, 65536);
        const channels = await credentialChannels();
        if (!channels.some((c) => c.id === b.channel))
          throw new HostError(
            "invalid_channel",
            "Choose an enabled physical upstream channel",
          );
        if (b.kind !== undefined && !["key", "oauth"].includes(b.kind))
          throw new HostError("invalid_request", "无效的授权类型");
        const kind = b.kind === "oauth" ? "oauth" : "key";
        const value =
          kind === "key"
            ? { key: requiredString(b.key, "key", 16384) }
            : b.oauth;
        if (kind === "oauth") {
          requiredString(value?.access_token, "access_token", 16384);
          for (const name of ["refresh_token", "account_id", "project_id"])
            if (value[name] !== undefined)
              requiredString(value[name], name, 16384);
          if (
            value.expires_at !== undefined &&
            (!Number.isSafeInteger(value.expires_at) || value.expires_at <= 0)
          )
            throw new HostError(
              "invalid_request",
              "expires_at must be epoch milliseconds",
            );
          for (const k of Object.keys(value))
            if (
              ![
                "access_token",
                "refresh_token",
                "expires_at",
                "account_id",
                "project_id",
              ].includes(k)
            )
              throw new HostError("invalid_request", "Unsupported OAuth field");
        }
        const row = {
          id: randomUUID(),
          user_id: ctx.principal.id,
          channel: b.channel,
          kind,
        };
        db.prepare("INSERT INTO credentials VALUES(?,?,?,?,?,?,?)").run(
          row.id,
          row.user_id,
          row.channel,
          requiredString(b.name, "name", 128),
          kind,
          encrypt(row, value),
          Date.now(),
        );
        return json({ id: row.id }, 201);
      },
    });
    host.api({
      method: "POST",
      path: "/revoke",
      access: "authenticated",
      handle: async (r, ctx) => {
        if (!ctx.principal?.session)
          throw new HostError(
            "session_required",
            "Console session required",
            403,
          );
        const b = await readObject(r);
        db.prepare("DELETE FROM credentials WHERE id=? AND user_id=?").run(
          requiredString(b.id, "id"),
          ctx.principal.id,
        );
        return json({ ok: true });
      },
    });
  },
});
