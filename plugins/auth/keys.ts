import { randomBytes, randomUUID, createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  HostError,
  json,
  readObject,
  requiredString,
  type Host,
  type RequestContext,
} from "@pluhub/sdk";

export const keysMigration = "ALTER TABLE api_keys ADD COLUMN secret TEXT;";
export const channelBindingsMigration = `ALTER TABLE api_keys ADD COLUMN channel_ids_json TEXT NOT NULL DEFAULT '[]';
 UPDATE api_keys SET channel_ids_json=json_array(channel_id) WHERE channel_id IS NOT NULL;`;
export const removeSingleBindingMigration =
  "ALTER TABLE api_keys DROP COLUMN channel_id; ALTER TABLE api_keys DROP COLUMN credential_id;";
export const keyChannelIds = (row: { channel_ids_json: string }): string[] =>
  JSON.parse(row.channel_ids_json);
type Vault = {
  encrypt: (value: string, aad: string) => string;
  decrypt: (value: string, aad: string) => string;
};
const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const safeJson = (value: unknown, status = 200) => {
  const response = json(value, status);
  response.headers.set("cache-control", "no-store");
  return response;
};
export function installKeys(
  host: Host,
  db: DatabaseSync,
  vault: Vault,
  tag: (value: { resourceId: string }) => void,
) {
  host.provide(
    "auth.key-names@1",
    ({ keys }: { keys: { id: string; userId: string }[] }) => {
      if (!Array.isArray(keys) || keys.length > 500)
        throw new HostError(
          "invalid_request",
          "Expected at most 500 key identities",
        );
      const find = db.prepare(
        "SELECT id,user_id AS userId,name FROM api_keys WHERE id=? AND user_id=?",
      );
      return keys.flatMap(({ id, userId }) => {
        const row = find.get(id, userId);
        return row ? [row] : [];
      });
    },
  );
  const owner = (ctx: RequestContext) => {
    if (!ctx.principal?.session)
      throw new HostError(
        "session_required",
        "Sign in to manage credentials",
        403,
      );
    return ctx.principal.id;
  };
  const ownKey = (ctx: RequestContext, id: string) => {
    const row = db
      .prepare("SELECT * FROM api_keys WHERE id=? AND user_id=?")
      .get(id, owner(ctx)) as any;
    if (!row) throw new HostError("not_found", "密钥不存在", 404);
    tag({ resourceId: id });
    return row;
  };
  async function keyBinding(body: any, userId: string, previous?: any) {
    const requested = body.channelIds ?? [];
    if (
      !Array.isArray(requested) ||
      requested.some(
        (id) => typeof id !== "string" || !id.trim() || id.length > 256,
      )
    )
      throw new HostError("invalid_binding", "无效的渠道列表");
    const channelIds = [...new Set<string>(requested)];
    const previousIds = previous ? keyChannelIds(previous) : [];
    if (channelIds.some((id) => !previousIds.includes(id))) {
      const options = await host.call<{ id: string }[]>("ai.channels@1", {
        userId,
      });
      if (
        channelIds.some(
          (id) =>
            !previousIds.includes(id) &&
            !options.some((channel) => channel.id === id),
        )
      )
        throw new HostError(
          "invalid_binding",
          "渠道不可用或不属于当前用户",
          403,
        );
    }
    return channelIds;
  }
  async function settings(body: any, userId: string, previous?: any) {
    if (
      Object.keys(body).some(
        (key) =>
          ![
            "id",
            "name",
            "channelIds",
            "models",
            "expiresAt",
            "requestsPerMinute",
          ].includes(key),
      )
    )
      throw new HostError("invalid_request", "无效的密钥配置字段");
    const name = requiredString(body.name, "name", 128),
      models = body.models ?? [];
    if (
      !Array.isArray(models) ||
      models.length > 256 ||
      models.some(
        (m: unknown) => typeof m !== "string" || !m.trim() || m.length > 256,
      )
    )
      throw new HostError("invalid_request", "Invalid model restrictions");
    const expires = body.expiresAt ?? null;
    if (
      expires !== null &&
      (!Number.isSafeInteger(expires) ||
        expires <= (previous ? 0 : Date.now()) ||
        expires > Date.now() + 3650 * 86400000)
    )
      throw new HostError("invalid_request", "Invalid key expiration");
    const rpm = body.requestsPerMinute ?? 0;
    if (!Number.isInteger(rpm) || rpm < 0 || rpm > 100000)
      throw new HostError("invalid_request", "Invalid request limit");
    const channel = await keyBinding(body, userId, previous);
    return {
      name,
      models: JSON.stringify([...new Set(models)]),
      expires,
      rpm,
      channel,
    };
  }
  host.api({
    method: "GET",
    path: "/keys",
    access: "authenticated",
    handle(_request, ctx) {
      return safeJson(
        db
          .prepare(
            "SELECT id,name,prefix,created_at,models_json,expires_at,requests_per_minute,last_used_at,channel_ids_json,secret IS NOT NULL AS can_copy FROM api_keys WHERE user_id=? ORDER BY created_at DESC,id",
          )
          .all(owner(ctx))
          .map((row: any) => {
            const { models_json, channel_ids_json, can_copy, ...key } = row;
            return {
              ...key,
              models: JSON.parse(models_json),
              canCopy: !!can_copy,
              channelIds: keyChannelIds(row),
            };
          }),
      );
    },
  });
  host.api({
    method: "POST",
    path: "/keys",
    access: "authenticated",
    async handle(request, ctx) {
      const userId = owner(ctx),
        config = await settings(await readObject(request), userId);
      const token = "ph_" + randomBytes(32).toString("base64url"),
        id = randomUUID();
      const secret = vault.encrypt(token, `api-key:${userId}:${id}`);
      db.prepare(
        "INSERT INTO api_keys(id,user_id,name,hash,prefix,created_at,models_json,expires_at,requests_per_minute,secret,channel_ids_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        userId,
        config.name,
        digest(token),
        token.slice(0, 10),
        new Date().toISOString(),
        config.models,
        config.expires,
        config.rpm,
        secret,
        JSON.stringify(config.channel),
      );
      tag({ resourceId: id });
      return safeJson({ id, token }, 201);
    },
  });
  host.api({
    method: "PUT",
    path: "/keys",
    access: "authenticated",
    async handle(request, ctx) {
      const body = await readObject(request),
        row = ownKey(ctx, requiredString(body.id, "id"));
      const config = await settings(body, row.user_id, row);
      db.prepare(
        "UPDATE api_keys SET name=?,models_json=?,expires_at=?,requests_per_minute=?,channel_ids_json=? WHERE id=? AND user_id=?",
      ).run(
        config.name,
        config.models,
        config.expires,
        config.rpm,
        JSON.stringify(config.channel),
        row.id,
        row.user_id,
      );
      return safeJson({ ok: true });
    },
  });
  host.api({
    method: "POST",
    path: "/keys/reveal",
    access: "authenticated",
    async handle(request, ctx) {
      const body = await readObject(request),
        row = ownKey(ctx, requiredString(body.id, "id"));
      if (!row.secret)
        throw new HostError(
          "key_not_recoverable",
          "此密钥未保存可恢复副本，请重新生成",
          409,
        );
      return safeJson({
        token: vault.decrypt(row.secret, `api-key:${row.user_id}:${row.id}`),
      });
    },
  });
  host.api({
    method: "POST",
    path: "/keys/rotate",
    access: "authenticated",
    async handle(request, ctx) {
      const body = await readObject(request),
        row = ownKey(ctx, requiredString(body.id, "id"));
      const token = "ph_" + randomBytes(32).toString("base64url");
      db.prepare(
        "UPDATE api_keys SET hash=?,prefix=?,secret=? WHERE id=? AND user_id=?",
      ).run(
        digest(token),
        token.slice(0, 10),
        vault.encrypt(token, `api-key:${row.user_id}:${row.id}`),
        row.id,
        row.user_id,
      );
      return safeJson({ id: row.id, token });
    },
  });
  host.api({
    method: "DELETE",
    path: "/keys",
    access: "authenticated",
    handle(request, ctx) {
      const userId = owner(ctx),
        id = requiredString(new URL(request.url).searchParams.get("id"), "id");
      const removed = db
        .prepare("DELETE FROM api_keys WHERE id=? AND user_id=?")
        .run(id, userId);
      if (removed.changes) tag({ resourceId: id });
      return safeJson({ ok: true });
    },
  });
}
