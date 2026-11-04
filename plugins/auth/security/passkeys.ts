import type { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import {
  HostError,
  readObject,
  requiredString,
  type RequestContext,
} from "@pluhub/sdk";
import { transaction } from "../../../lib/storage/sqlite.js";

const digest = (s: string) => createHash("sha256").update(s).digest("hex");

export function validateWebauthnConfig(c: Record<string, any>) {
  const w = c.webauthn as any;
  if (!w?.enabled) return;
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

export interface PasskeyDeps {
  db: DatabaseSync;
  cfg: () => Record<string, any>;
  services: {
    lookup: (v: any) => Promise<any>;
    history: { tag: (value: any) => void };
  };
  passwordReset: {
    passkeyUser: (challenge: unknown, r: Request) => Promise<any>;
  };
  limit: (id: string, max: number, span: number) => void;
  peer: (r: Request) => string;
  captcha: (
    action: "login" | "register" | "email",
    token: unknown,
    signal: AbortSignal,
  ) => Promise<void>;
  requireSession: (ctx: RequestContext) => string;
  requireRecent: (r: Request, ctx: RequestContext) => string;
  sessionToken: (r: Request) => string | undefined;
  bindingToken: (r: Request) => string | undefined;
  enabledUser: (id: string) => Promise<any>;
  issue: (
    user: any,
    credentialId?: string,
    request?: Request,
    method?: string,
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
  safeJson: (v: unknown, status?: number) => Response;
  api: (
    method: string,
    path: string,
    access: string,
    handle: (r: Request, ctx: RequestContext) => Response | Promise<Response>,
  ) => void;
}

export function installPasskeys(deps: PasskeyDeps) {
  const { db, cfg, services } = deps;

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

  deps.api("POST", "/passkeys/register/options", "authenticated", async (r, ctx) => {
    const id = deps.requireRecent(r, ctx),
      w = webauthn(),
      b = await readObject(r),
      user = await deps.enabledUser(id);
    deps.limit("key-enroll:" + id, 20, 3600000);
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
    const challengeId = deps.challenge("key-register", {
      userId: id,
      secret: JSON.stringify({
        challenge: opts.challenge,
        name: requiredString(b.name, "name", 128),
      }),
      binding: digest(deps.sessionToken(r)!),
    });
    return deps.safeJson({ challenge: challengeId, options: opts });
  });

  deps.api("POST", "/passkeys/register/verify", "authenticated", async (r, ctx) => {
    const id = deps.requireRecent(r, ctx),
      w = webauthn(),
      b = await readObject(r, 262144),
      row = deps.readChallenge(
        b.challenge,
        "key-register",
        digest(deps.sessionToken(r)!),
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
    return deps.safeJson({ ok: true });
  });

  for (const reauthenticate of [false, true]) {
    const path = "/passkeys/" + (reauthenticate ? "reauth" : "login");
    const access = reauthenticate ? "authenticated" : "public";
    const kind = reauthenticate ? "key-reauth" : "key-login";
    deps.api("POST", path + "/options", access, async (r, ctx) => {
      const w = webauthn();
      deps.limit("key-login:" + deps.peer(r), 30, 900000);
      const b = await readObject(r);
      let user = reauthenticate
        ? await deps.enabledUser(deps.requireSession(ctx))
        : b.resetChallenge
          ? await deps.passwordReset.passkeyUser(b.resetChallenge, r)
          : undefined;
      if (!reauthenticate && !b.resetChallenge)
        await deps.captcha("login", b.captchaToken, ctx.signal);
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
      const id = deps.challenge(kind, {
        userId: user?.id,
        secret: opts.challenge,
      });
      db.prepare("UPDATE auth_challenges SET binding=? WHERE id=?").run(
        digest(reauthenticate ? deps.sessionToken(r)! : id),
        digest(id),
      );
      const out = deps.safeJson({ challenge: id, options: opts });
      if (!reauthenticate)
        out.headers.set("set-cookie", deps.cookie("pluhub_challenge", id, 300));
      return out;
    });

    deps.api("POST", path + "/verify", access, async (r, ctx) => {
      const w = webauthn();
      deps.limit("key-verify:" + deps.peer(r), 30, 900000);
      const sessionUser = reauthenticate ? deps.requireSession(ctx) : undefined;
      const b = await readObject(r, 262144),
        row = deps.readChallenge(
          b.challenge,
          kind,
          digest(
            (reauthenticate ? deps.sessionToken(r) : deps.bindingToken(r)) ?? "",
          ),
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
      const user = await deps.enabledUser(stored.user_id);
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
        ).run(Date.now(), digest(deps.sessionToken(r)!), user.id, Date.now());
        return deps.safeJson({ ok: true });
      }
      return deps.issue(user, id, r, "passkey");
    });
  }

  deps.api("DELETE", "/passkeys", "authenticated", async (r, ctx) => {
    const userId = deps.requireRecent(r, ctx),
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
    return deps.safeJson({ ok: true });
  });
}
