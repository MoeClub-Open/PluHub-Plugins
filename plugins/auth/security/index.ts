import type { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomInt } from "node:crypto";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import QRCode from "qrcode";
import {
  HostError,
  json,
  readObject,
  requiredString,
  type Host,
  type RequestContext,
} from "@pluhub/sdk";
import { authVault, base32, matchTotp } from "./crypto.js";
import { emailAddress } from "../../../lib/identity/email.js";
import {
  mailBranding,
  mailLanguage,
  verificationMail,
  verificationLifetimeMs,
  type VerificationPurpose,
} from "../../../lib/mail/templates.js";
import { transaction } from "../../../lib/storage/sqlite.js";
import { createSession, installSessions } from "../sessions.js";
import {
  installPasswordReset,
  passwordResetEnabled,
  resetCookieName,
  resetToken,
} from "./password-reset.js";
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
  function factor(userId: string, code: unknown, recovery: unknown) {
    const row = db
      .prepare("SELECT * FROM totp_credentials WHERE user_id=?")
      .get(userId) as any;
    if (!row) return false;
    if (typeof recovery === "string" && /^[a-f0-9-]{20,40}$/i.test(recovery)) {
      const hash = vault.hash(
        "recovery:" + userId + ":" + recovery.toLowerCase().replaceAll("-", ""),
      );
      return (
        db
          .prepare("DELETE FROM recovery_codes WHERE user_id=? AND hash=?")
          .run(userId, hash).changes === 1
      );
    }
    const step = matchTotp(
      vault.decrypt(row.secret, "totp:" + userId),
      code,
      row.last_counter,
    );
    if (step === undefined) return false;
    return (
      db
        .prepare(
          "UPDATE totp_credentials SET last_counter=? WHERE user_id=? AND last_counter<?",
        )
        .run(step, userId, step).changes === 1
    );
  }
  function recoveryCodes(userId: string) {
    const codes = Array.from({ length: 10 }, () =>
      randomBytes(12).toString("hex"),
    );
    transaction(db, () => {
      db.prepare("DELETE FROM recovery_codes WHERE user_id=?").run(userId);
      for (const code of codes)
        db.prepare("INSERT INTO recovery_codes VALUES(?,?)").run(
          userId,
          vault.hash("recovery:" + userId + ":" + code),
        );
    });
    return codes.map((c) => c.match(/.{1,6}/g)!.join("-"));
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
    await captcha("login", b.captchaToken ?? b.turnstileToken, signal);
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
    const w = c.webauthn as any;
    if (w?.enabled) {
      if (!w.rpID || !w.origins?.length)
        throw new HostError(
          "invalid_config",
          "WebAuthn needs explicit RP ID and origins",
        );
      for (const origin of w.origins) {
        let u: URL;
        try {
          u = new URL(origin);
        } catch {
          throw new HostError("invalid_config", "Invalid WebAuthn origin");
        }
        if (
          u.origin !== origin ||
          u.username ||
          u.password ||
          (u.hostname !== w.rpID && !u.hostname.endsWith("." + w.rpID)) ||
          (u.protocol !== "https:" &&
            !(
              u.protocol === "http:" &&
              u.hostname === "localhost" &&
              w.rpID === "localhost"
            ))
        )
          throw new HostError(
            "invalid_config",
            "WebAuthn origin must use HTTPS and belong to the RP ID; localhost HTTP is for development",
          );
        if (u.protocol === "https:" && !c.secureCookie)
          throw new HostError(
            "invalid_config",
            "HTTPS WebAuthn requires secureCookie",
          );
      }
    }
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
            ...(!bot.provider || bot.provider === "turnstile"
              ? { turnstile: { enabled: bot.enabled, siteKey: bot.siteKey } }
              : {}),
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
  api("POST", "/totp/setup", "authenticated", async (r, ctx) => {
    const id = requireRecent(r, ctx);
    if (hasTotp(id))
      throw new HostError("already_enabled", "TOTP is already enabled", 409);
    const secret = base32(randomBytes(20));
    db.prepare(
      "DELETE FROM auth_challenges WHERE kind='totp' AND user_id=?",
    ).run(id);
    const token = challenge("totp", {
      userId: id,
      secret: vault.encrypt(secret, "totp:" + id),
      binding: digest(sessionToken(r)!),
    });
    const user = await enabledUser(id);
    const issuer = String(cfg().issuer ?? "PluHub"),
      uri =
        "otpauth://totp/" +
        encodeURIComponent(issuer + ":" + user.username) +
        "?secret=" +
        secret +
        "&issuer=" +
        encodeURIComponent(issuer) +
        "&algorithm=SHA1&digits=6&period=30";
    return safeJson({
      challenge: token,
      secret,
      uri,
      qrDataURL: await QRCode.toDataURL(uri, { width: 240, margin: 2 }),
    });
  });
  api("POST", "/totp/confirm", "authenticated", async (r, ctx) => {
    const id = requireRecent(r, ctx),
      b = await readObject(r),
      row = readChallenge(b.challenge, "totp", digest(sessionToken(r)!));
    if (row.user_id !== id)
      throw new HostError(
        "forbidden",
        "Challenge belongs to another user",
        403,
      );
    const step = matchTotp(vault.decrypt(row.secret, "totp:" + id), b.code, -1);
    if (step === undefined)
      throw new HostError("invalid_factor", "Invalid authenticator code", 401);
    if (hasTotp(id))
      throw new HostError("already_enabled", "TOTP already enabled", 409);
    transaction(db, () => {
      consume(row);
      db.prepare("INSERT INTO totp_credentials VALUES(?,?,?)").run(
        id,
        row.secret,
        step,
      );
      db.prepare("DELETE FROM sessions WHERE user_id=? AND hash<>?").run(
        id,
        digest(sessionToken(r)!),
      );
      db.prepare("UPDATE sessions SET auth_at=? WHERE hash=?").run(
        Date.now(),
        digest(sessionToken(r)!),
      );
    });
    return safeJson({ ok: true, recoveryCodes: recoveryCodes(id) });
  });
  api("DELETE", "/totp", "authenticated", async (r, ctx) => {
    const id = requireRecent(r, ctx);
    transaction(db, () => {
      db.prepare("DELETE FROM totp_credentials WHERE user_id=?").run(id);
      db.prepare("DELETE FROM recovery_codes WHERE user_id=?").run(id);
      db.prepare("DELETE FROM auth_challenges WHERE user_id=?").run(id);
      db.prepare("DELETE FROM sessions WHERE user_id=? AND hash<>?").run(
        id,
        digest(sessionToken(r)!),
      );
    });
    return safeJson({ ok: true });
  });
  api("POST", "/recovery-codes", "authenticated", async (r, ctx) => {
    const id = requireRecent(r, ctx);
    if (!hasTotp(id)) throw new HostError("not_enabled", "Enable TOTP first");
    return safeJson({ recoveryCodes: recoveryCodes(id) });
  });
  api("POST", "/email/request", "public", async (r, ctx) => {
    const b = await readObject(r),
      email = emailAddress(b.email),
      purpose = requiredString(b.purpose, "purpose", 16);
    if (!["login", "register", "bind", "reset"].includes(purpose))
      throw new HostError("invalid_request", "Invalid email purpose");
    let userId: string | undefined;
    if (purpose === "bind") userId = requireRecent(r, ctx);
    if (
      (purpose === "register" &&
        (!cfg().registrationEnabled || !(await services.initialized()))) ||
      (purpose === "login" && !cfg().emailLoginEnabled) ||
      (purpose === "reset" &&
        (!passwordResetEnabled(cfg()) || !(await services.initialized())))
    )
      throw new HostError(
        "not_enabled",
        "This verification method is disabled",
        403,
      );
    const action =
      purpose === "register" && (cfg().captcha as any)?.register
        ? "register"
        : ["login", "reset"].includes(purpose) && (cfg().captcha as any)?.login
          ? "login"
          : "email";
    if (purpose !== "bind")
      await captcha(action, b.captchaToken ?? b.turnstileToken, ctx.signal);
    limit("mail-peer:" + peer(r), 30, 3600000);
    limit("mail-cooldown:" + digest(email), 1, 60000);
    limit("mail-email:" + digest(email), 5, 3600000);
    const available = await options();
    if (!available.mailEnabled)
      throw new HostError(
        "mail_unavailable",
        "Email delivery is not enabled",
        503,
      );
    const existing = db
      .prepare("SELECT user_id FROM email_credentials WHERE email=?")
      .get(email) as any;
    if (["login", "reset"].includes(purpose)) userId = existing?.user_id;
    const recipient = userId
      ? await services.lookup({ id: userId })
      : undefined;
    const valid =
      purpose === "bind" ||
      (purpose === "register" && !existing) ||
      (["login", "reset"].includes(purpose) && !!userId && recipient?.enabled);
    const resetNonce =
      purpose === "reset" ? randomBytes(32).toString("base64url") : undefined;
    const code = String(randomInt(100000, 1000000)),
      id = challenge(
        valid ? "email-" + purpose : "email-unused",
        {
          userId,
          email,
          ...(purpose === "bind" ? { binding: digest(sessionToken(r)!) } : {}),
          ...(resetNonce ? { binding: digest(resetNonce) } : {}),
        },
        verificationLifetimeMs,
      );
    db.prepare("UPDATE auth_challenges SET secret=? WHERE id=?").run(
      vault.hash(id + ":" + code),
      digest(id),
    );
    if (valid)
      try {
        const brand = await mailBranding(host, ctx.signal);
        await host.call(
          "mail.send@1",
          verificationMail({
            to: email,
            purpose: purpose as VerificationPurpose,
            code,
            language: mailLanguage(
              recipient?.language,
              b.language,
              brand.defaultLanguage,
            ),
            brand,
          }),
          ctx.signal,
        );
      } catch {
        db.prepare("DELETE FROM auth_challenges WHERE id=?").run(digest(id));
        host.log("warn", "Verification email delivery failed");
        ctx.signal.throwIfAborted();
      }
    const out = safeJson({
      ok: true,
      challenge: id,
      message: "If this address is eligible, a verification code has been sent",
    });
    if (resetNonce)
      out.headers.append(
        "set-cookie",
        cookie(
          resetCookieName(cfg()),
          resetNonce,
          verificationLifetimeMs / 1000,
        ),
      );
    return out;
  });
  function emailProof(b: any, purpose: string, r: Request) {
    const row = readChallenge(
      b.challenge,
      "email-" + purpose,
      purpose === "bind"
        ? digest(sessionToken(r) ?? "")
        : purpose === "reset"
          ? digest(resetToken(r, cfg()) ?? "")
          : undefined,
    );
    const code = requiredString(b.code, "code", 6);
    if (
      row.email !== emailAddress(b.email) ||
      row.secret !== vault.hash(b.challenge + ":" + code)
    )
      throw new HostError(
        "invalid_code",
        "Invalid email verification code",
        401,
      );
    return row;
  }
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
  api("POST", "/register", "public", async (r) => {
    if (!cfg().registrationEnabled || !(await services.initialized()))
      throw new HostError("not_enabled", "Registration is disabled", 403);
    limit("register:" + peer(r), 15, 900000);
    const b = await readObject(r),
      username = requiredString(b.username, "username", 64).toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(username))
      throw new HostError("invalid_username", "Invalid username");
    const proof = emailProof(b, "register", r);
    if (
      (await services.lookup({ username })) ||
      db
        .prepare("SELECT 1 FROM email_credentials WHERE email=?")
        .get(proof.email)
    )
      throw new HostError(
        "account_unavailable",
        "This account cannot be registered",
        409,
      );
    const hash = await services.hashPassword(
      requiredString(b.password, "password", 1024),
    );
    consume(proof);
    const user = await host.call<any>("users.manage@1", {
      action: "create",
      username,
      role: "user",
    });
    services.history.tag({ userId: user.id });
    transaction(db, () => {
      db.prepare("INSERT INTO passwords VALUES(?,?)").run(user.id, hash);
      db.prepare("INSERT INTO email_credentials VALUES(?,?,?)").run(
        user.id,
        proof.email,
        Date.now(),
      );
    });
    return issue(user, undefined, r, "email");
  });
  api("POST", "/email/login", "public", async (r) => {
    if (!cfg().emailLoginEnabled)
      throw new HostError("not_enabled", "Email login is disabled", 403);
    limit("email-login:" + peer(r), 30, 900000);
    const b = await readObject(r),
      row = emailProof(b, "login", r),
      user = await enabledUser(row.user_id);
    services.history.tag({ userId: user.id });
    if (verifiedEmail(user.id) !== row.email)
      throw new HostError(
        "invalid_credentials",
        "Email login address changed; start again",
        401,
      );
    consume(row);
    return finishPrimary(user, r, "email");
  });
  api("POST", "/email/bind", "authenticated", async (r, ctx) => {
    const id = requireRecent(r, ctx),
      b = await readObject(r),
      row = emailProof(b, "bind", r);
    if (row.user_id !== id)
      throw new HostError(
        "forbidden",
        "Challenge belongs to another user",
        403,
      );
    transaction(db, () => {
      consume(row);
      try {
        db.prepare(
          "INSERT INTO email_credentials VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,verified_at=excluded.verified_at",
        ).run(id, row.email, Date.now());
        db.prepare(
          "DELETE FROM auth_challenges WHERE user_id=? AND kind IN ('email-reset','password-reset-mfa')",
        ).run(id);
      } catch {
        throw new HostError(
          "email_unavailable",
          "Email is already linked",
          409,
        );
      }
    });
    return safeJson({ ok: true });
  });
  function webauthn() {
    const c = cfg().webauthn as any;
    if (!c?.enabled)
      throw new HostError(
        "not_enabled",
        "Passkey authentication is disabled",
        403,
      );
    return c;
  }
  function sameOriginResponse(response: any) {
    const encoded = response?.response?.clientDataJSON;
    if (typeof encoded !== "string" || encoded.length > 8192)
      throw Error("Invalid client data");
    const client = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    );
    if (
      (client.crossOrigin !== undefined && client.crossOrigin !== false) ||
      client.topOrigin !== undefined
    )
      throw Error("Cross-origin WebAuthn is disabled");
  }
  api("POST", "/passkeys/register/options", "authenticated", async (r, ctx) => {
    const id = requireRecent(r, ctx),
      w = webauthn(),
      b = await readObject(r),
      user = await enabledUser(id);
    limit("key-enroll:" + id, 20, 3600000);
    if (
      (
        db
          .prepare("SELECT count(*) n FROM passkeys WHERE user_id=?")
          .get(id) as any
      ).n >= 20
    )
      throw new HostError(
        "credential_limit",
        "At most 20 credentials per user",
      );
    const opts = await generateRegistrationOptions({
      rpName: w.rpName ?? "PluHub",
      rpID: w.rpID,
      userName: user.username,
      userID: new TextEncoder().encode(id),
      attestationType: "none",
      supportedAlgorithmIDs: [-7, -257],
      excludeCredentials: (
        db
          .prepare("SELECT id,transports FROM passkeys WHERE user_id=?")
          .all(id) as any[]
      ).map((x) => ({ id: x.id, transports: JSON.parse(x.transports) })),
      authenticatorSelection: {
        ...(b.kind === "hardware"
          ? {
              authenticatorAttachment: "cross-platform" as const,
              residentKey: "preferred" as const,
            }
          : { residentKey: "required" as const }),
        userVerification: "required",
      },
      preferredAuthenticatorType:
        b.kind === "hardware" ? "securityKey" : undefined,
    });
    const challengeId = challenge("key-register", {
      userId: id,
      secret: JSON.stringify({
        challenge: opts.challenge,
        name: requiredString(b.name, "name", 128),
      }),
      binding: digest(sessionToken(r)!),
    });
    return safeJson({ challenge: challengeId, options: opts });
  });
  api("POST", "/passkeys/register/verify", "authenticated", async (r, ctx) => {
    const id = requireRecent(r, ctx),
      w = webauthn(),
      b = await readObject(r, 262144),
      row = readChallenge(
        b.challenge,
        "key-register",
        digest(sessionToken(r)!),
        true,
      );
    if (row.user_id !== id)
      throw new HostError("forbidden", "Wrong credential owner", 403);
    const state = JSON.parse(row.secret);
    let result;
    try {
      sameOriginResponse(b.response);
      result = await verifyRegistrationResponse({
        response: b.response,
        expectedChallenge: state.challenge,
        expectedOrigin: w.origins,
        expectedRPID: w.rpID,
        requireUserVerification: true,
        supportedAlgorithmIDs: [-7, -257],
      });
    } catch {
      throw new HostError(
        "invalid_webauthn",
        "Security key registration verification failed",
        400,
      );
    }
    if (!result.verified)
      throw new HostError(
        "invalid_webauthn",
        "Registration verification failed",
      );
    const info = result.registrationInfo,
      c = info.credential;
    try {
      db.prepare("INSERT INTO passkeys VALUES(?,?,?,?,?,?,?,?,?,NULL)").run(
        c.id,
        id,
        state.name,
        Buffer.from(c.publicKey).toString("base64"),
        c.counter,
        JSON.stringify(c.transports ?? []),
        info.credentialDeviceType,
        info.credentialBackedUp ? 1 : 0,
        Date.now(),
      );
    } catch {
      throw new HostError(
        "credential_exists",
        "This credential is already registered",
        409,
      );
    }
    services.history.tag({ resourceId: "passkey:" + digest(c.id) });
    return safeJson({ ok: true });
  });
  for (const reauthenticate of [false, true]) {
    const path = "/passkeys/" + (reauthenticate ? "reauth" : "login");
    const access = reauthenticate ? "authenticated" : "public";
    const kind = reauthenticate ? "key-reauth" : "key-login";
    api("POST", path + "/options", access, async (r, ctx) => {
      const w = webauthn();
      limit("key-login:" + peer(r), 30, 900000);
      const b = await readObject(r);
      let user = reauthenticate
        ? await enabledUser(requireSession(ctx))
        : b.resetChallenge
          ? await passwordReset.passkeyUser(b.resetChallenge, r)
          : undefined;
      if (!reauthenticate && !b.resetChallenge)
        await captcha("login", b.captchaToken ?? b.turnstileToken, ctx.signal);
      let allowed;
      if (b.username || user) {
        user ??= await services.lookup({
          username: requiredString(b.username, "username", 64).toLowerCase(),
        });
        allowed = user
          ? (
              db
                .prepare("SELECT id,transports FROM passkeys WHERE user_id=?")
                .all(user.id) as any[]
            ).map((c) => ({ id: c.id, transports: JSON.parse(c.transports) }))
          : [];
        if (!allowed.length)
          allowed = [
            { id: randomBytes(32).toString("base64url"), transports: [] },
          ];
      }
      const opts = await generateAuthenticationOptions({
        rpID: w.rpID,
        userVerification: "required",
        allowCredentials: allowed,
      });
      const id = challenge(kind, {
        userId: user?.id,
        secret: opts.challenge,
      });
      db.prepare("UPDATE auth_challenges SET binding=? WHERE id=?").run(
        digest(reauthenticate ? sessionToken(r)! : id),
        digest(id),
      );
      const out = safeJson({ challenge: id, options: opts });
      if (!reauthenticate)
        out.headers.set("set-cookie", cookie("pluhub_challenge", id, 300));
      return out;
    });
    api("POST", path + "/verify", access, async (r, ctx) => {
      const w = webauthn();
      limit("key-verify:" + peer(r), 30, 900000);
      const sessionUser = reauthenticate ? requireSession(ctx) : undefined;
      const b = await readObject(r, 262144),
        row = readChallenge(
          b.challenge,
          kind,
          digest((reauthenticate ? sessionToken(r) : bindingToken(r)) ?? ""),
          true,
        );
      const id = requiredString(b.response?.id, "credential id", 2048),
        stored = db.prepare("SELECT * FROM passkeys WHERE id=?").get(id) as any;
      if (
        !stored ||
        (row.user_id && stored.user_id !== row.user_id) ||
        (reauthenticate && stored.user_id !== sessionUser)
      )
        throw new HostError(
          "invalid_credentials",
          "Authentication failed",
          401,
        );
      const user = await enabledUser(stored.user_id);
      services.history.tag({ userId: user.id });
      const handle = b.response?.response?.userHandle;
      if (
        handle &&
        Buffer.from(handle, "base64url").toString("utf8") !== user.id
      )
        throw new HostError(
          "invalid_webauthn",
          "Credential owner mismatch",
          401,
        );
      let result;
      try {
        sameOriginResponse(b.response);
        result = await verifyAuthenticationResponse({
          response: b.response,
          expectedChallenge: row.secret,
          expectedOrigin: w.origins,
          expectedRPID: w.rpID,
          requireUserVerification: true,
          credential: {
            id: stored.id,
            publicKey: new Uint8Array(Buffer.from(stored.public_key, "base64")),
            counter: stored.counter,
            transports: JSON.parse(stored.transports),
          },
        });
      } catch {
        throw new HostError(
          "invalid_webauthn",
          "Security key authentication failed",
          401,
        );
      }
      if (!result.verified)
        throw new HostError("invalid_webauthn", "Authentication failed", 401);
      const info = result.authenticationInfo;
      if (
        !db
          .prepare(
            "UPDATE passkeys SET counter=?,backed_up=?,last_used_at=? WHERE id=? AND counter=?",
          )
          .run(
            info.newCounter,
            info.credentialBackedUp ? 1 : 0,
            Date.now(),
            id,
            stored.counter,
          ).changes
      )
        throw new HostError(
          "invalid_webauthn",
          "Credential state changed; try again",
          401,
        );
      if (reauthenticate) {
        db.prepare(
          "UPDATE sessions SET auth_at=? WHERE hash=? AND user_id=? AND expires>?",
        ).run(Date.now(), digest(sessionToken(r)!), user.id, Date.now());
        return safeJson({ ok: true });
      }
      return issue(user, id, r, "passkey");
    });
  }
  api("DELETE", "/passkeys", "authenticated", async (r, ctx) => {
    const userId = requireRecent(r, ctx),
      id = requiredString(new URL(r.url).searchParams.get("id"), "id", 2048);
    transaction(db, () => {
      const own = db
        .prepare("SELECT 1 FROM passkeys WHERE id=? AND user_id=?")
        .get(id, userId);
      if (!own) throw new HostError("not_found", "Credential not found", 404);
      db.prepare("DELETE FROM passkeys WHERE id=? AND user_id=?").run(
        id,
        userId,
      );
      db.prepare(
        "DELETE FROM sessions WHERE user_id=? AND credential_id=?",
      ).run(userId, id);
    });
    services.history.tag({ resourceId: "passkey:" + digest(id) });
    return safeJson({ ok: true });
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
