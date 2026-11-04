import type { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import {
  HostError,
  json,
  readObject,
  requiredString,
  type Host,
  type RequestContext,
} from "@pluhub/sdk";
import { authVault } from "./crypto.js";
import { transaction } from "../../../lib/storage/sqlite.js";
import { createSession, installSessions } from "../sessions.js";
import {
  installPasswordReset,
  passwordResetEnabled,
} from "./password-reset.js";
import { createTotpTools } from "./totp.js";
import { installEmailAuth } from "./email.js";
import { installPasskeys, validateWebauthnConfig } from "./passkeys.js";

export const securityMigration = `
 ALTER TABLE sessions ADD COLUMN auth_at INTEGER NOT NULL DEFAULT 0;
 ALTER TABLE sessions ADD COLUMN credential_id TEXT;
 CREATE TABLE auth_challenges(id TEXT PRIMARY KEY,kind TEXT NOT NULL,user_id TEXT,email TEXT,secret TEXT,binding TEXT,expires INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE email_credentials(user_id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,verified_at INTEGER NOT NULL);
 CREATE TABLE totp_credentials(user_id TEXT PRIMARY KEY,secret TEXT NOT NULL,last_counter INTEGER NOT NULL DEFAULT -1);
 CREATE TABLE recovery_codes(user_id TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(user_id,hash));
 CREATE TABLE passkeys(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,public_key TEXT NOT NULL,counter INTEGER NOT NULL,transports TEXT NOT NULL,device_type TEXT NOT NULL,backed_up INTEGER NOT NULL,created_at INTEGER NOT NULL,last_used_at INTEGER);
 CREATE INDEX passkeys_user ON passkeys(user_id);
 CREATE TABLE auth_limits(id TEXT PRIMARY KEY,started INTEGER NOT NULL,count INTEGER NOT NULL);
`;

const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const sessionToken = (r: Request) =>
  /(?:^|;\s*)pluhub_session=([a-zA-Z0-9_-]+)/.exec(
    r.headers.get("cookie") ?? "",
  )?.[1];
const bindingToken = (r: Request) =>
  /(?:^|;\s*)pluhub_challenge=([a-zA-Z0-9_-]+)/.exec(
    r.headers.get("cookie") ?? "",
  )?.[1];
const safeJson = (v: unknown, status = 200) => {
  const r = json(v, status);
  r.headers.set("cache-control", "no-store");
  return r;
};

interface Services {
  lookup: (v: any) => Promise<any>;
  createUser: (username: string) => any;
  verifyPassword: (password: string, hash: string) => Promise<boolean>;
  dummy: string;
  hashPassword: (password: string) => Promise<string>;
  initialized: () => Promise<boolean>;
  history: {
    tag: (value: {
      userId?: string;
      actorId?: string;
      method?: string;
      challenge?: boolean;
      resourceId?: string;
    }) => void;
    local: (
      action: "password.admin_reset" | "account.bootstrap" | "factors.reset",
      userId: string,
    ) => void;
  };
}

export function installAuthSecurity(
  host: Host,
  db: DatabaseSync,
  services: Services,
) {
  const vault = authVault(
    host.dataDir,
    Number(
      (
        db
          .prepare(
            "SELECT (SELECT count(*) FROM totp_credentials)+(SELECT count(*) FROM api_keys WHERE secret IS NOT NULL) n",
          )
          .get() as any
      ).n,
    ) > 0,
  );
  host.cleanup(() => vault.close());
  const cfg = () => host.config();
  const limit = (id: string, max: number, span: number) => {
    const now = Date.now();
    db.prepare(
      "INSERT INTO auth_limits VALUES(?,?,1) ON CONFLICT(id) DO UPDATE SET count=CASE WHEN started<=? THEN 1 ELSE count+1 END,started=CASE WHEN started<=? THEN excluded.started ELSE started END",
    ).run(id, now, now - span, now - span);
    if (
      (db.prepare("SELECT count FROM auth_limits WHERE id=?").get(id) as any)
        .count > max
    )
      throw new HostError(
        "rate_limited",
        "Too many attempts; try again later",
        429,
      );
  };
  const peer = (r: Request) => r.headers.get("x-pluhub-peer") ?? "local";
  const sweep = setInterval(() => {
    const now = Date.now();
    db.prepare("DELETE FROM auth_challenges WHERE expires<?").run(now);
    db.prepare("DELETE FROM auth_limits WHERE started<?").run(now - 86400000);
    db.prepare("DELETE FROM sessions WHERE expires<?").run(now);
  }, 60000);
  sweep.unref();
  host.cleanup(() => clearInterval(sweep));
  const verifiedEmail = (id: string) =>
    (
      db
        .prepare("SELECT email FROM email_credentials WHERE user_id=?")
        .get(id) as any
    )?.email ?? null;
  const hasTotp = (id: string) =>
    !!db.prepare("SELECT 1 FROM totp_credentials WHERE user_id=?").get(id);
  function requireSession(ctx: RequestContext) {
    if (!ctx.principal?.session)
      throw new HostError(
        "session_required",
        "Sign in to manage verification methods",
        403,
      );
    return ctx.principal.id;
  }
  function requireRecent(r: Request, ctx: RequestContext) {
    const id = requireSession(ctx),
      token = sessionToken(r);
    const row = token
      ? (db
          .prepare(
            "SELECT auth_at FROM sessions WHERE hash=? AND user_id=? AND expires>?",
          )
          .get(digest(token), id, Date.now()) as any)
      : undefined;
    if (!row || row.auth_at < Date.now() - 300000)
      throw new HostError(
        "reauth_required",
        "Sign in again or confirm your identity before changing security settings",
        403,
      );
    return id;
  }
  function cookie(name: string, value: string, age: number) {
    return (
      name +
      "=" +
      value +
      "; HttpOnly; SameSite=Strict; Path=/; Max-Age=" +
      age +
      (cfg().secureCookie ? "; Secure" : "")
    );
  }
  installSessions(host, db, requireRecent, (resourceId) =>
    services.history.tag({ resourceId }),
  );
  async function issue(
    user: any,
    credentialId?: string,
    request?: Request,
    method = "password",
  ) {
    const current = await services.lookup({ id: user.id });
    if (!current?.enabled)
      throw new HostError("invalid_credentials", "Authentication failed", 401);
    limit("session-issuance:" + user.id, 100, 86400000);
    const token = randomBytes(32).toString("base64url");
    createSession(db, {
      hash: digest(token),
      userId: user.id,
      credentialId,
      request,
      method,
    });
    services.history.tag({
      userId: user.id,
      actorId: user.id,
      ...(method !== "mfa" ? { method } : {}),
    });
    const r = safeJson({ ...current, email: verifiedEmail(user.id) });
    r.headers.append("set-cookie", cookie("pluhub_session", token, 604800));
    r.headers.append("set-cookie", cookie("pluhub_challenge", "", 0));
    return r;
  }
  function challenge(
    kind: string,
    data: {
      userId?: string;
      email?: string;
      secret?: string;
      binding?: string;
    },
    ttl = 300000,
  ) {
    const id = randomBytes(32).toString("base64url");
    db.prepare(
      "INSERT INTO auth_challenges(id,kind,user_id,email,secret,binding,expires) VALUES(?,?,?,?,?,?,?)",
    ).run(
      digest(id),
      kind,
      data.userId ?? null,
      data.email ?? null,
      data.secret ?? null,
      data.binding ?? null,
      Date.now() + ttl,
    );
    return id;
  }
  function readChallenge(
    id: unknown,
    kind: string,
    binding?: string,
    burn = false,
  ) {
    const key = digest(requiredString(id, "challenge", 128));
    const row = db
      .prepare(
        "SELECT * FROM auth_challenges WHERE id=? AND kind=? AND expires>? AND attempts<5",
      )
      .get(key, kind, Date.now()) as any;
    if (!row || (row.binding && row.binding !== binding))
      throw new HostError(
        "invalid_challenge",
        "Verification expired or is invalid; start again",
        400,
      );
    if (burn) {
      if (
        !db.prepare("DELETE FROM auth_challenges WHERE id=?").run(key).changes
      )
        throw new HostError("invalid_challenge", "Challenge already used");
    } else
      db.prepare(
        "UPDATE auth_challenges SET attempts=attempts+1 WHERE id=?",
      ).run(key);
    return row;
  }
  function consume(row: any) {
    if (
      !db.prepare("DELETE FROM auth_challenges WHERE id=?").run(row.id).changes
    )
      throw new HostError("invalid_challenge", "Challenge already used");
  }
  async function captcha(
    action: "login" | "register" | "email",
    token: unknown,
    signal: AbortSignal,
  ) {
    if (!(cfg().captcha as any)?.[action]) return;
    await host.call("captcha.verify@1", { token, action }, signal);
  }
  async function enabledUser(id: string) {
    services.history.tag({ userId: id });
    const user = await services.lookup({ id });
    if (!user?.enabled)
      throw new HostError("invalid_credentials", "Authentication failed", 401);
    return user;
  }
  async function finishPrimary(user: any, request: Request, method: string) {
    services.history.tag({ userId: user.id, method });
    if (!hasTotp(user.id)) return issue(user, undefined, request, method);
    const id = challenge("mfa", { userId: user.id });
    db.prepare("UPDATE auth_challenges SET binding=? WHERE id=?").run(
      digest(id),
      digest(id),
    );
    const r = safeJson({
      mfaRequired: true,
      challenge: id,
      methods: ["totp", "recovery"],
    });
    services.history.tag({ challenge: true });
    r.headers.set("set-cookie", cookie("pluhub_challenge", id, 300));
    return r;
  }
  async function passwordLogin(r: Request, signal: AbortSignal) {
    limit("login:" + peer(r), 30, 900000);
    const b = await readObject(r);
    await captcha("login", b.captchaToken, signal);
    const username = requiredString(b.username, "username", 64).toLowerCase(),
      password = requiredString(b.password, "password", 1024);
    const user = await services.lookup({ username });
    services.history.tag({ userId: user?.id });
    const stored = user
      ? (db
          .prepare("SELECT hash FROM passwords WHERE user_id=?")
          .get(user.id) as any)
      : undefined;
    const valid = await services.verifyPassword(
      password,
      stored?.hash ?? services.dummy,
    );
    if (!valid || !stored || !user?.enabled)
      throw new HostError(
        "invalid_credentials",
        "Invalid username or password",
        401,
      );
    return finishPrimary(user, r, "password");
  }
  host.validateConfig((c) => {
    if (
      c.registrationEnabled ||
      c.emailLoginEnabled ||
      c.passwordResetEnabled
    ) {
      if (
        !host.hasCapability("mail.send@1") ||
        !host.hasCapability("mail.options@1")
      )
        throw new HostError(
          "invalid_config",
          "Enable the mail plugin before email authentication or recovery",
        );
    }
    if (
      Object.values(c.captcha ?? {}).some(Boolean) &&
      (!host.hasCapability("captcha.verify@1") ||
        !host.hasCapability("captcha.options@1"))
    )
      throw new HostError(
        "invalid_config",
        "启用人机验证策略前，请先配置并启用验证服务。",
      );
    validateWebauthnConfig(c);
  });
  async function options() {
    const mail = host.hasCapability("mail.options@1")
      ? await host.call<any>("mail.options@1")
      : { enabled: false };
    const bot = host.hasCapability("captcha.options@1")
      ? await host.call<any>("captcha.options@1")
      : { enabled: false };
    const required = Object.values(cfg().captcha ?? {}).some(Boolean);
    return {
      registrationEnabled:
        cfg().registrationEnabled === true && (await services.initialized()),
      emailLoginEnabled: cfg().emailLoginEnabled === true,
      passwordResetEnabled:
        passwordResetEnabled(cfg()) && (await services.initialized()),
      mailEnabled: mail.enabled,
      webauthnEnabled: (cfg().webauthn as any)?.enabled === true,
      captcha: cfg().captcha ?? {},
      ...(required
        ? {
            captchaProvider: {
              enabled: bot.enabled,
              provider: bot.provider ?? "turnstile",
              siteKey: bot.siteKey,
              ...(bot.provider === "recaptcha"
                ? {
                    recaptchaVersion: bot.recaptchaVersion,
                    recaptchaDomain: bot.recaptchaDomain,
                  }
                : {}),
            },
          }
        : {}),
    };
  }
  const api = (
    method: string,
    path: string,
    access: string,
    handle: (r: Request, ctx: RequestContext) => Response | Promise<Response>,
  ) => host.api({ method, path, access, handle, audit: path !== "/reauth" });

  const { factor } = createTotpTools({
    db,
    vault,
    cfg,
    hasTotp,
    requireRecent,
    sessionHash: (r) => digest(sessionToken(r)!),
    challenge,
    readChallenge,
    consume,
    enabledUser,
    safeJson,
    api,
  });

  api("GET", "/options", "public", async () => safeJson(await options()));
  api("POST", "/login/mfa", "public", async (r) => {
    limit("mfa:" + peer(r), 30, 900000);
    const b = await readObject(r),
      row = readChallenge(b.challenge, "mfa", digest(bindingToken(r) ?? ""));
    const user = await enabledUser(row.user_id);
    services.history.tag({
      userId: user.id,
      method: typeof b.recoveryCode === "string" ? "recovery" : "totp",
    });
    if (!factor(user.id, b.code, b.recoveryCode))
      throw new HostError(
        "invalid_factor",
        "Invalid or already used verification code",
        401,
      );
    consume(row);
    return issue(user, undefined, r, "mfa");
  });
  api("POST", "/reauth", "authenticated", async (r, ctx) => {
    const id = requireSession(ctx);
    limit("reauth:" + id, 15, 900000);
    const b = await readObject(r),
      row = db
        .prepare("SELECT hash FROM passwords WHERE user_id=?")
        .get(id) as any;
    services.history.tag({
      method: hasTotp(id)
        ? typeof b.recoveryCode === "string"
          ? "recovery"
          : "totp"
        : "password",
    });
    const valid = await services.verifyPassword(
      requiredString(b.password, "password", 1024),
      row?.hash ?? services.dummy,
    );
    if (!valid || !row || (hasTotp(id) && !factor(id, b.code, b.recoveryCode)))
      throw new HostError(
        "invalid_credentials",
        "Identity confirmation failed",
        401,
      );
    db.prepare("UPDATE sessions SET auth_at=? WHERE hash=? AND user_id=?").run(
      Date.now(),
      digest(sessionToken(r)!),
      id,
    );
    return safeJson({ ok: true });
  });
  api("GET", "/security", "authenticated", async (_r, ctx) => {
    const id = requireSession(ctx);
    return safeJson({
      ...(await options()),
      passwordSet: !!db
        .prepare("SELECT 1 FROM passwords WHERE user_id=?")
        .get(id),
      email: verifiedEmail(id),
      totpEnabled: hasTotp(id),
      recoveryCodesRemaining: (
        db
          .prepare("SELECT count(*) n FROM recovery_codes WHERE user_id=?")
          .get(id) as any
      ).n,
      passkeys: db
        .prepare(
          "SELECT id,name,transports,device_type,backed_up,created_at,last_used_at FROM passkeys WHERE user_id=? ORDER BY created_at",
        )
        .all(id),
    });
  });

  const { emailProof } = installEmailAuth({
    host,
    db,
    vault,
    cfg,
    services,
    limit,
    peer,
    options,
    captcha,
    requireRecent,
    sessionToken,
    verifiedEmail,
    enabledUser,
    issue,
    finishPrimary,
    cookie,
    challenge,
    readChallenge,
    consume,
    safeJson,
    api,
  });

  const passwordReset = installPasswordReset(host, db, {
    enabledUser,
    hashPassword: services.hashPassword,
    emailProof,
    challenge,
    readChallenge,
    consume,
    factor,
    encrypt: (value, binding) => vault.encrypt(value, binding),
    decrypt: (value, binding) => vault.decrypt(value, binding),
    cookie,
    limit,
    history: services.history,
  });

  installPasskeys({
    db,
    cfg,
    services,
    passwordReset,
    limit,
    peer,
    captcha,
    requireSession,
    requireRecent,
    sessionToken,
    bindingToken,
    enabledUser,
    issue,
    cookie,
    challenge,
    readChallenge,
    safeJson,
    api,
  });

  host.provide("auth.reset-factors@1", async (input) => {
    const user = await services.lookup({
      username: requiredString(input.username, "username", 64).toLowerCase(),
    });
    if (!user) throw new HostError("not_found", "User not found", 404);
    transaction(db, () => {
      for (const table of [
        "totp_credentials",
        "recovery_codes",
        "passkeys",
        "auth_challenges",
        "sessions",
      ])
        db.prepare("DELETE FROM " + table + " WHERE user_id=?").run(user.id);
    });
    services.history.local("factors.reset", user.id);
    return { ok: true };
  });

  return {
    passwordLogin,
    requireRecent,
    email: verifiedEmail,
    keyVault: { encrypt: vault.encrypt, decrypt: vault.decrypt },
  };
}
