import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  HostError,
  json,
  readObject,
  requiredString,
  type Host,
} from "@pluhub/sdk";
import { transaction } from "../../../lib/storage/sqlite.js";
import { storePassword } from "../passwords.js";
export const resetCookieName = (config: Record<string, unknown>) =>
  config.secureCookie === true ? "__Host-pluhub_reset" : "pluhub_reset";
export function resetToken(r: Request, config: Record<string, unknown>) {
  const name = resetCookieName(config);
  const matches = (r.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(name + "="));
  // Reject ambiguous cookies instead of choosing an attacker-controlled duplicate.
  if (matches.length !== 1) return;
  const value = matches[0]!.slice(name.length + 1);
  return /^[a-zA-Z0-9_-]{43}$/.test(value) ? value : undefined;
}
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export const passwordResetEnabled = (config: Record<string, unknown>) =>
  config.passwordResetEnabled === true ||
  (config.passwordResetEnabled === undefined &&
    config.emailLoginEnabled === true);
type Challenge = {
  id: string;
  user_id: string;
  email: string;
  secret: string;
  expires: number;
};
type State = {
  passwordHash: string;
  expectedHash: string | null;
  createdAt: number;
  existingSessions: string[];
};
interface Services {
  history: {
    tag: (details: {
      userId?: string;
      actorId?: string;
      method?: string;
      challenge?: boolean;
    }) => void;
  };
  enabledUser: (id: string) => Promise<any>;
  hashPassword: (password: string) => Promise<string>;
  emailProof: (input: any, purpose: string, request: Request) => Challenge;
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
  readChallenge: (id: unknown, kind: string, binding?: string) => Challenge;
  consume: (row: Challenge) => void;
  factor: (userId: string, code: unknown, recovery: unknown) => boolean;
  encrypt: (value: string, binding: string) => string;
  decrypt: (value: string, binding: string) => string;
  cookie: (name: string, value: string, seconds: number) => string;
  limit: (id: string, count: number, span: number) => void;
}
const invalid = () =>
  new HostError(
    "invalid_challenge",
    "Password recovery expired or changed; start again",
    400,
  );
export function installPasswordReset(
  host: Host,
  db: DatabaseSync,
  services: Services,
) {
  const currentHash = (id: string) =>
    (db.prepare("SELECT hash FROM passwords WHERE user_id=?").get(id) as any)
      ?.hash ?? null;
  const currentEmail = (id: string) =>
    (
      db
        .prepare("SELECT email FROM email_credentials WHERE user_id=?")
        .get(id) as any
    )?.email;
  function enabled() {
    if (!passwordResetEnabled(host.config()))
      throw new HostError("not_enabled", "Password recovery is disabled", 403);
  }
  function assertCurrent(row: Challenge, state: State) {
    if (
      row.email !== currentEmail(row.user_id) ||
      state.expectedHash !== currentHash(row.user_id)
    )
      throw invalid();
    if (
      !db
        .prepare(
          "SELECT 1 FROM auth_challenges WHERE id=? AND expires>? AND attempts<=5",
        )
        .get(row.id, Date.now())
    )
      throw invalid();
  }
  function read(id: unknown, request: Request) {
    enabled();
    const row = services.readChallenge(
      id,
      "password-reset-mfa",
      digest(resetToken(request, host.config()) ?? ""),
    );
    let state: State;
    try {
      state = JSON.parse(
        services.decrypt(row.secret, "password-reset:" + row.user_id),
      );
    } catch {
      throw invalid();
    }
    assertCurrent(row, state);
    return { row, state };
  }
  function response(data: unknown) {
    const result = json(data);
    result.headers.set("cache-control", "no-store");
    return result;
  }
  function complete(row: Challenge, state: State, username: string) {
    assertCurrent(row, state);
    services.consume(row);
    storePassword(db, row.user_id, state.passwordHash);
    const result = response({ ok: true, username });
    for (const name of [
      "pluhub_session",
      "pluhub_challenge",
      resetCookieName(host.config()),
    ])
      result.headers.append("set-cookie", services.cookie(name, "", 0));
    return result;
  }
  host.api({
    method: "POST",
    path: "/password/reset",
    access: "public",
    handle: async (request, ctx) => {
      enabled();
      services.limit(
        "password-reset:" + (request.headers.get("x-pluhub-peer") ?? "local"),
        15,
        900000,
      );
      const body = await readObject(request),
        row = services.emailProof(body, "reset", request);
      await services.enabledUser(row.user_id);
      const expectedHash = currentHash(row.user_id),
        passwordHash = await services.hashPassword(
          requiredString(body.password, "password", 1024),
        );
      const user = await services.enabledUser(row.user_id);
      services.history.tag({ userId: user.id });
      ctx.signal.throwIfAborted();
      const state: State = {
        passwordHash,
        expectedHash,
        createdAt: Date.now(),
        existingSessions: [],
      };
      return transaction(db, () => {
        assertCurrent(row, state);
        if (
          !db
            .prepare("SELECT 1 FROM totp_credentials WHERE user_id=?")
            .get(row.user_id)
        ) {
          const out = complete(row, state, user.username);
          services.history.tag({ actorId: user.id });
          return out;
        }
        state.existingSessions = (
          db
            .prepare("SELECT hash FROM sessions WHERE user_id=?")
            .all(user.id) as any[]
        ).map((r) => r.hash);
        services.consume(row);
        const challenge = services.challenge("password-reset-mfa", {
          userId: user.id,
          email: row.email,
          binding: digest(resetToken(request, host.config()) ?? ""),
          secret: services.encrypt(
            JSON.stringify(state),
            "password-reset:" + user.id,
          ),
        });
        const passkey =
          (host.config().webauthn as any)?.enabled &&
          db.prepare("SELECT 1 FROM passkeys WHERE user_id=?").get(user.id);
        const out = response({
          mfaRequired: true,
          challenge,
          username: user.username,
          methods: ["totp", "recovery", ...(passkey ? ["passkey"] : [])],
        });
        services.history.tag({ challenge: true });
        out.headers.append(
          "set-cookie",
          services.cookie(
            resetCookieName(host.config()),
            resetToken(request, host.config())!,
            300,
          ),
        );
        return out;
      });
    },
  });
  host.api({
    method: "POST",
    path: "/password/reset/finish",
    access: "public",
    handle: async (request, ctx) => {
      services.limit(
        "password-reset-mfa:" +
          (request.headers.get("x-pluhub-peer") ?? "local"),
        30,
        900000,
      );
      const body = await readObject(request),
        { row, state } = read(body.challenge, request),
        user = await services.enabledUser(row.user_id);
      services.history.tag({
        userId: user.id,
        method: typeof body.recoveryCode === "string" ? "recovery" : "totp",
      });
      ctx.signal.throwIfAborted();
      return transaction(db, () => {
        assertCurrent(row, state);
        const sessionToken = /(?:^|;\s*)pluhub_session=([a-zA-Z0-9_-]+)/.exec(
          request.headers.get("cookie") ?? "",
        )?.[1];
        const sessionHash = sessionToken ? digest(sessionToken) : undefined;
        const freshPasskey =
          ctx.principal?.session &&
          ctx.principal.id === user.id &&
          sessionHash &&
          !state.existingSessions.includes(sessionHash) &&
          db
            .prepare(
              "SELECT 1 FROM sessions s JOIN passkeys p ON p.id=s.credential_id AND p.user_id=s.user_id WHERE s.hash=? AND s.user_id=? AND s.auth_at>=? AND s.expires>?",
            )
            .get(sessionHash, user.id, state.createdAt, Date.now());
        if (
          !freshPasskey &&
          !services.factor(user.id, body.code, body.recoveryCode)
        )
          throw new HostError(
            "invalid_factor",
            "Invalid or already used verification code",
            401,
          );
        const out = complete(row, state, user.username);
        services.history.tag({
          actorId: user.id,
          ...(freshPasskey ? { method: "passkey" } : {}),
        });
        return out;
      });
    },
  });
  return {
    async passkeyUser(challenge: unknown, request: Request) {
      const { row, state } = read(challenge, request),
        user = await services.enabledUser(row.user_id);
      assertCurrent(row, state);
      return user;
    },
  };
}
