import { openDatabase, transaction } from "../../lib/storage/sqlite.js";
import { storePassword } from "./passwords.js";
import { installAuthSecurity, securityMigration } from "./security/index.js";
import { adminTarget } from "../../lib/admin/access.js";
import { installAdmin } from "./admin.js";
import { installSetup, setupMigration } from "./setup.js";
import { sessionMigration } from "./sessions.js";
import { installSecurityHistory, historyMigration } from "./history.js";
import { join } from "node:path";
import {
  randomBytes,
  randomUUID,
  createHash,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import {
  definePlugin,
  HostError,
  json,
  readObject,
  requiredString,
} from "@pluhub/sdk";
const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const derive = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
const hashPassword = async (password: string) => {
  if (password.length < 12 || password.length > 1024)
    throw new HostError(
      "invalid_password",
      "Password must contain 12–1024 characters",
    );
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + (await derive(password, salt)).toString("hex");
};
const verify = async (password: string, hash: string) => {
  const [salt, expected] = hash.split(":");
  const key = await derive(password, salt!);
  const stored = Buffer.from(expected!, "hex");
  return key.length === stored.length && timingSafeEqual(key, stored);
};
const cookie = (request: Request) =>
  /(?:^|;\s*)pluhub_session=([a-zA-Z0-9_-]+)/.exec(
    request.headers.get("cookie") ?? "",
  )?.[1];
export default definePlugin({
  async setup(rawHost) {
    const db = openDatabase(join(rawHost.dataDir, "auth.sqlite"), [
      "CREATE TABLE IF NOT EXISTS passwords(user_id TEXT PRIMARY KEY,hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS api_keys(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,hash TEXT UNIQUE NOT NULL,prefix TEXT NOT NULL,created_at TEXT NOT NULL);",
      "ALTER TABLE api_keys ADD COLUMN models_json TEXT NOT NULL DEFAULT '[]'; ALTER TABLE api_keys ADD COLUMN expires_at INTEGER; ALTER TABLE api_keys ADD COLUMN requests_per_minute INTEGER NOT NULL DEFAULT 0; ALTER TABLE api_keys ADD COLUMN last_used_at INTEGER;",
      securityMigration,
      "ALTER TABLE api_keys ADD COLUMN channel_id TEXT; ALTER TABLE api_keys ADD COLUMN credential_id TEXT;",
      setupMigration,
      sessionMigration,
      historyMigration,
    ]);
    rawHost.cleanup(() => db.close());
    const history = installSecurityHistory(rawHost, db),
      host = history.host;
    const lookup = (input: any) => host.call<any>("users.lookup@1", input);
    const dummy = await hashPassword(randomBytes(24).toString("hex"));
    const setPassword = async (userId: string, password: string) => {
      if (!(await lookup({ id: userId })))
        throw new HostError("not_found", "User not found", 404);
      const hash = await hashPassword(password);
      transaction(db, () => storePassword(db, userId, hash));
    };
    const installation = await installSetup(host, db, hashPassword, (id) =>
      history.local("account.bootstrap", id),
    );
    const security = installAuthSecurity(host, db, {
      lookup,
      verifyPassword: verify,
      dummy,
      hashPassword,
      initialized: installation.initialized,
      history,
    });
    host.provide("auth.admin@1", async ({ userId, token }) => {
      if (typeof token !== "string")
        throw new HostError(
          "reauth_required",
          "请在账号设置中确认管理员身份后重试",
          403,
        );
      const row = db
        .prepare(
          "SELECT auth_at FROM sessions WHERE hash=? AND user_id=? AND expires>?",
        )
        .get(digest(token), userId, Date.now()) as any;
      const user = await lookup({ id: userId });
      if (!row || row.auth_at < Date.now() - 300000)
        throw new HostError(
          "reauth_required",
          "请在账号设置中确认管理员身份后重试（有效五分钟）",
          403,
        );
      if (!user?.enabled || user.role !== "admin")
        throw new HostError("forbidden", "需要管理员身份", 403);
      return { id: user.id };
    });
    installAdmin(host, db);
    host.provide("auth.bootstrap@1", async (input) => {
      let userId = input.userId;
      if (!userId) {
        const username = requiredString(input.username, "username", 64);
        let user = await lookup({ username: username.toLowerCase() });
        if (!user)
          user = await host.call<any>("users.manage@1", {
            action: "create",
            username,
            role: "admin",
          });
        if (user.role !== "admin" || !user.enabled)
          throw new HostError(
            "invalid_admin",
            "Bootstrap target must be an enabled administrator",
          );
        userId = user.id;
      }
      await setPassword(
        requiredString(userId, "userId"),
        requiredString(input.password, "password", 1024),
      );
      history.local("account.bootstrap", userId);
      return true;
    });
    host.identity(async (request) => {
      const url = new URL(request.url);
      const key =
        request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
        request.headers.get("x-api-key") ??
        request.headers.get("x-goog-api-key") ??
        (url.pathname.startsWith("/v1beta/")
          ? url.searchParams.get("key")
          : null);
      const token = key ?? cookie(request);
      if (!token) return undefined;
      const row = (
        key
          ? db
              .prepare(
                "SELECT * FROM api_keys WHERE hash=? AND (expires_at IS NULL OR expires_at>?)",
              )
              .get(digest(token), Date.now())
          : db
              .prepare(
                "SELECT user_id,last_active_at FROM sessions WHERE hash=? AND expires>?",
              )
              .get(digest(token), Date.now())
      ) as any;
      if (!row) return undefined;
      const user = await lookup({ id: row.user_id });
      if (!user?.enabled) return undefined;
      if (
        !key &&
        host.config().secureCookie &&
        !["GET", "HEAD", "OPTIONS"].includes(request.method)
      ) {
        let origin = request.headers.get("origin");
        if (!origin) {
          const referer = request.headers.get("referer");
          try {
            if (referer && !referer.includes(",")) {
              const source = new URL(referer);
              if (!source.username && !source.password) origin = source.origin;
            }
          } catch {
            /* An invalid Referer cannot authorize a session mutation. */
          }
        }
        if (origin !== url.origin)
          throw new HostError(
            "csrf",
            "安全会话写入需要同源 Origin 或 Referer",
            403,
          );
      }
      if (key && (row.last_used_at ?? 0) < Date.now() - 60000)
        db.prepare("UPDATE api_keys SET last_used_at=? WHERE id=?").run(
          Date.now(),
          row.id,
        );
      if (!key && row.last_active_at < Date.now() - 60000)
        db.prepare("UPDATE sessions SET last_active_at=? WHERE hash=?").run(
          Date.now(),
          digest(token),
        );
      return {
        id: user.id,
        permissions: !key && user.role === "admin" ? ["*"] : [],
        session: !key,
        ...(key
          ? {
              attributes: {
                keyId: row.id,
                models: JSON.parse(row.models_json),
                requestsPerMinute: row.requests_per_minute,
                channelId: row.channel_id ?? undefined,
                credentialId: row.credential_id ?? undefined,
              },
            }
          : {}),
      };
    });
    const requireSession = (principal: { session?: boolean }) => {
      if (!principal.session)
        throw new HostError(
          "session_required",
          "Sign in to manage credentials",
          403,
        );
    };
    host.api({
      method: "POST",
      path: "/users",
      access: "users.manage",
      handle: async (request, ctx) => {
        requireSession(ctx.principal!);
        security.requireRecent(request, ctx);
        const body = await readObject(request);
        // Validate and hash the initial password before creating user facts.
        // A rejected password must never leave a passwordless account behind.
        const hash = await hashPassword(
          requiredString(body.password, "password", 1024),
        );
        const user = await host.call<any>("users.manage@1", {
          action: "create",
          username: body.username,
          role: body.role ?? "user",
          accountType: body.accountType,
          parentId: body.parentId,
        });
        adminTarget(ctx, user.id);
        try {
          db.prepare("INSERT INTO passwords VALUES(?,?)").run(user.id, hash);
        } catch (error) {
          await host.call("users.manage@1", {
            action: "update",
            id: user.id,
            enabled: false,
          });
          throw error;
        }
        return json(user, 201);
      },
    });
    const windows = new Map<string, { minute: number; count: number }>();
    function admit({
      model,
      principal,
    }: {
      model: string;
      principal?: { attributes?: Readonly<Record<string, unknown>> };
    }) {
      const policy = principal?.attributes;
      if (!policy?.keyId) return;
      const allowed = policy.models as string[];
      if (allowed.length && !allowed.includes(model))
        throw new HostError(
          "model_forbidden",
          "API key cannot access this model",
          403,
        );
      const limit = Number(policy.requestsPerMinute);
      if (!limit) return;
      const minute = Math.floor(Date.now() / 60000);
      const id = String(policy.keyId);
      let window = windows.get(id);
      if (!window || window.minute !== minute) {
        window = { minute, count: 0 };
        windows.set(id, window);
      }
      if (++window.count > limit)
        throw new HostError(
          "rate_limited",
          "API key request limit exceeded",
          429,
        );
      if (windows.size > 5000)
        for (const [k, w] of windows)
          if (w.minute !== minute) windows.delete(k);
    }
    host.provide("auth.admit@1", admit);
    host.hook({
      id: "key-policy",
      phase: "Admission",
      handle(ctx) {
        if (!ctx.state.has("ai.request")) return;
        const model = (ctx.state.get("ai.request") as { model: string }).model;
        if (ctx.state.get("auth.preflight") === model) return;
        admit({ model, principal: ctx.principal });
      },
    });
    host.api({
      method: "POST",
      path: "/login",
      access: "public",
      handle: (request, ctx) => security.passwordLogin(request, ctx.signal),
    });
    host.api({
      method: "POST",
      path: "/logout",
      access: "authenticated",
      handle: (request) => {
        const token = cookie(request);
        if (token)
          db.prepare("DELETE FROM sessions WHERE hash=?").run(digest(token));
        return new Response("{}", {
          headers: {
            "content-type": "application/json",
            "set-cookie":
              "pluhub_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
          },
        });
      },
    });
    host.api({
      method: "GET",
      path: "/me",
      access: "authenticated",
      handle: async (_request, ctx) =>
        json({
          ...(await lookup({ id: ctx.principal!.id })),
          email: security.email(ctx.principal!.id),
        }),
    });
    host.api({
      method: "PATCH",
      path: "/preferences",
      access: "authenticated",
      handle: async (request, ctx) => {
        requireSession(ctx.principal!);
        const body = await readObject(request);
        if (
          Object.keys(body).some((key) => key !== "language") ||
          !["zh-CN", "en-US"].includes(body.language as string)
        )
          throw new HostError("invalid_language", "Unsupported language");
        const user = await host.call<any>("users.manage@1", {
          action: "preferences",
          id: ctx.principal!.id,
          language: body.language,
        });
        return json({ language: user.language });
      },
    });
    host.api({
      method: "POST",
      path: "/password",
      access: "authenticated",
      handle: async (request, ctx) => {
        requireSession(ctx.principal!);
        security.requireRecent(request, ctx);
        const body = await readObject(request);
        const id = body.userId ?? ctx.principal!.id;
        adminTarget(
          ctx,
          id,
          undefined,
          typeof body.reason === "string" ? body.reason : undefined,
        );
        const admin = ctx.principal!.permissions.includes("*");
        if (!admin && id !== ctx.principal!.id)
          throw new HostError(
            "forbidden",
            "Cannot change another user password",
            403,
          );
        if (!admin || id === ctx.principal!.id) {
          const row = db
            .prepare("SELECT hash FROM passwords WHERE user_id=?")
            .get(ctx.principal!.id) as any;
          if (
            !row ||
            !(await verify(
              requiredString(body.currentPassword, "currentPassword", 1024),
              row.hash,
            ))
          )
            throw new HostError(
              "invalid_credentials",
              "Current password is incorrect",
              401,
            );
        }
        await setPassword(
          requiredString(id, "userId"),
          requiredString(body.password, "password", 1024),
        );
        return json({ ok: true });
      },
    });
    host.api({
      method: "GET",
      path: "/keys",
      access: "authenticated",
      handle: (_r, ctx) => {
        requireSession(ctx.principal!);
        return json(
          db
            .prepare(
              "SELECT id,name,prefix,created_at,models_json,expires_at,requests_per_minute,last_used_at,channel_id,credential_id FROM api_keys WHERE user_id=? ORDER BY created_at DESC",
            )
            .all(ctx.principal!.id)
            .map((row: any) => {
              const { models_json, ...key } = row;
              return { ...key, models: JSON.parse(models_json) };
            }),
        );
      },
    });
    async function keyBinding(body: any, userId: string) {
      const channelId = body.channelId
        ? requiredString(body.channelId, "channelId", 256)
        : null;
      let credentialId = body.credentialId
        ? requiredString(body.credentialId, "credentialId", 256)
        : null;
      if (credentialId && !channelId)
        throw new HostError("invalid_binding", "请先选择凭证绑定的渠道");
      if (channelId) {
        const options = await host.call<{ id: string; scope: string }[]>(
          "ai.channels@1",
          { userId },
        );
        const channel = options.find((c) => c.id === channelId);
        if (!channel)
          throw new HostError(
            "invalid_binding",
            "渠道不可用或不属于当前用户",
            403,
          );
        if (channel.scope === "personal") {
          if (credentialId && credentialId !== channelId)
            throw new HostError(
              "invalid_binding",
              "个人渠道使用其自己的凭证",
              403,
            );
          credentialId = channelId;
        }
        if (credentialId)
          await host.call("credentials.select@1", {
            id: credentialId,
            userId,
            channel: channelId,
          });
      }
      return { channelId, credentialId };
    }
    host.api({
      method: "POST",
      path: "/keys",
      access: "authenticated",
      handle: async (request, ctx) => {
        requireSession(ctx.principal!);
        const body = await readObject(request);
        const binding = await keyBinding(body, ctx.principal!.id);
        const models = body.models ?? [];
        if (
          !Array.isArray(models) ||
          models.length > 256 ||
          models.some(
            (m: unknown) =>
              typeof m !== "string" || !m.trim() || m.length > 256,
          )
        )
          throw new HostError("invalid_request", "Invalid model restrictions");
        const expires = body.expiresAt ?? null;
        if (
          expires !== null &&
          (!Number.isSafeInteger(expires) ||
            expires <= Date.now() ||
            expires > Date.now() + 3650 * 86400000)
        )
          throw new HostError("invalid_request", "Invalid key expiration");
        const rpm = body.requestsPerMinute ?? 0;
        if (!Number.isInteger(rpm) || rpm < 0 || rpm > 100000)
          throw new HostError("invalid_request", "Invalid request limit");
        const token = "ph_" + randomBytes(32).toString("base64url");
        const id = randomUUID();
        db.prepare(
          "INSERT INTO api_keys(id,user_id,name,hash,prefix,created_at,models_json,expires_at,requests_per_minute,channel_id,credential_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        ).run(
          id,
          ctx.principal!.id,
          requiredString(body.name, "name", 128),
          digest(token),
          token.slice(0, 10),
          new Date().toISOString(),
          JSON.stringify([...new Set(models)]),
          expires,
          rpm,
          binding.channelId,
          binding.credentialId,
        );
        history.tag({ resourceId: id });
        return json({ id, token }, 201);
      },
    });
    host.api({
      method: "PUT",
      path: "/keys/binding",
      access: "authenticated",
      handle: async (request, ctx) => {
        requireSession(ctx.principal!);
        const body = await readObject(request),
          userId = ctx.principal!.id;
        const id = requiredString(body.id, "id");
        if (
          !db
            .prepare("SELECT id FROM api_keys WHERE id=? AND user_id=?")
            .get(id, userId)
        )
          throw new HostError("not_found", "密钥不存在", 404);
        const binding = await keyBinding(body, userId);
        db.prepare(
          "UPDATE api_keys SET channel_id=?,credential_id=? WHERE id=? AND user_id=?",
        ).run(binding.channelId, binding.credentialId, id, userId);
        history.tag({ resourceId: id });
        return json({ ok: true });
      },
    });
    host.api({
      method: "DELETE",
      path: "/keys",
      access: "authenticated",
      handle: (request, ctx) => {
        requireSession(ctx.principal!);
        const id = new URL(request.url).searchParams.get("id");
        const removed = db
          .prepare("DELETE FROM api_keys WHERE id=? AND user_id=?")
          .run(requiredString(id, "id"), ctx.principal!.id);
        if (removed.changes) history.tag({ resourceId: id! });
        return json({ ok: true });
      },
    });
  },
});
