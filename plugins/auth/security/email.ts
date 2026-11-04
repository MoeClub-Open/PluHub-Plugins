import type { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomInt } from "node:crypto";
import {
  HostError,
  readObject,
  requiredString,
  type Host,
  type RequestContext,
} from "@pluhub/sdk";
import { emailAddress } from "../../../lib/identity/email.js";
import {
  mailBranding,
  mailLanguage,
  verificationMail,
  verificationLifetimeMs,
  type VerificationPurpose,
} from "../../../lib/mail/templates.js";
import { transaction } from "../../../lib/storage/sqlite.js";
import { passwordResetEnabled, resetCookieName, resetToken } from "./password-reset.js";

const digest = (s: string) => createHash("sha256").update(s).digest("hex");

export interface EmailAuthDeps {
  host: Host;
  db: DatabaseSync;
  vault: { hash: (value: string) => string };
  cfg: () => Record<string, any>;
  services: {
    lookup: (v: any) => Promise<any>;
    createUser: (username: string) => any;
    hashPassword: (password: string) => Promise<string>;
    initialized: () => Promise<boolean>;
    history: { tag: (value: any) => void };
  };
  limit: (id: string, max: number, span: number) => void;
  peer: (r: Request) => string;
  options: () => Promise<any>;
  captcha: (
    action: "login" | "register" | "email",
    token: unknown,
    signal: AbortSignal,
  ) => Promise<void>;
  requireRecent: (r: Request, ctx: RequestContext) => string;
  sessionToken: (r: Request) => string | undefined;
  verifiedEmail: (id: string) => string | null;
  enabledUser: (id: string) => Promise<any>;
  issue: (
    user: any,
    credentialId?: string,
    request?: Request,
    method?: string,
  ) => Promise<Response>;
  finishPrimary: (
    user: any,
    request: Request,
    method: string,
  ) => Promise<Response>;
  cookie: (name: string, value: string, age: number) => string;
  challenge: (
    kind: string,
    data: {
      userId?: string;
      email?: string;
      secret?: string;
      binding?: string;
    },
    ttl?: number,
  ) => string;
  readChallenge: (
    id: unknown,
    kind: string,
    binding?: string,
    burn?: boolean,
  ) => any;
  consume: (row: any) => void;
  safeJson: (v: unknown, status?: number) => Response;
  api: (
    method: string,
    path: string,
    access: string,
    handle: (r: Request, ctx: RequestContext) => Response | Promise<Response>,
  ) => void;
}

export function installEmailAuth(deps: EmailAuthDeps) {
  const { host, db, vault, cfg, services } = deps;

  function emailProof(b: any, purpose: string, r: Request) {
    const row = deps.readChallenge(
      b.challenge,
      "email-" + purpose,
      purpose === "bind"
        ? digest(deps.sessionToken(r) ?? "")
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

  deps.api("POST", "/email/request", "public", async (r, ctx) => {
    const b = await readObject(r),
      email = emailAddress(b.email),
      purpose = requiredString(b.purpose, "purpose", 16);
    if (!["login", "register", "bind", "reset"].includes(purpose))
      throw new HostError("invalid_request", "Invalid email purpose");
    let userId: string | undefined;
    if (purpose === "bind") userId = deps.requireRecent(r, ctx);
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
      await deps.captcha(action, b.captchaToken, ctx.signal);
    deps.limit("mail-peer:" + deps.peer(r), 30, 3600000);
    deps.limit("mail-cooldown:" + digest(email), 1, 60000);
    deps.limit("mail-email:" + digest(email), 5, 3600000);
    const available = await deps.options();
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
      id = deps.challenge(
        valid ? "email-" + purpose : "email-unused",
        {
          userId,
          email,
          ...(purpose === "bind"
            ? { binding: digest(deps.sessionToken(r)!) }
            : {}),
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
    const out = deps.safeJson({
      ok: true,
      challenge: id,
      message: "If this address is eligible, a verification code has been sent",
    });
    if (resetNonce)
      out.headers.append(
        "set-cookie",
        deps.cookie(
          resetCookieName(cfg()),
          resetNonce,
          verificationLifetimeMs / 1000,
        ),
      );
    return out;
  });

  deps.api("POST", "/register", "public", async (r) => {
    if (!cfg().registrationEnabled || !(await services.initialized()))
      throw new HostError("not_enabled", "Registration is disabled", 403);
    deps.limit("register:" + deps.peer(r), 15, 900000);
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
    const user = transaction(db, () => {
      deps.consume(proof);
      const created = services.createUser(username)!;
      db.prepare("INSERT INTO passwords VALUES(?,?)").run(created.id, hash);
      db.prepare("INSERT INTO email_credentials VALUES(?,?,?)").run(
        created.id,
        proof.email,
        Date.now(),
      );
      return created;
    });
    services.history.tag({ userId: user.id });
    return deps.issue(user, undefined, r, "email");
  });

  deps.api("POST", "/email/login", "public", async (r) => {
    if (!cfg().emailLoginEnabled)
      throw new HostError("not_enabled", "Email login is disabled", 403);
    deps.limit("email-login:" + deps.peer(r), 30, 900000);
    const b = await readObject(r),
      row = emailProof(b, "login", r),
      user = await deps.enabledUser(row.user_id);
    services.history.tag({ userId: user.id });
    if (deps.verifiedEmail(user.id) !== row.email)
      throw new HostError(
        "invalid_credentials",
        "Email login address changed; start again",
        401,
      );
    deps.consume(row);
    return deps.finishPrimary(user, r, "email");
  });

  deps.api("POST", "/email/bind", "authenticated", async (r, ctx) => {
    const id = deps.requireRecent(r, ctx),
      b = await readObject(r),
      row = emailProof(b, "bind", r);
    if (row.user_id !== id)
      throw new HostError(
        "forbidden",
        "Challenge belongs to another user",
        403,
      );
    transaction(db, () => {
      deps.consume(row);
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
    return deps.safeJson({ ok: true });
  });

  return { emailProof };
}
