import type { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import {
  HostError,
  readObject,
  type RequestContext,
} from "@pluhub/sdk";
import { base32, matchTotp } from "./crypto.js";
import { transaction } from "../../../lib/storage/sqlite.js";

export interface TotpDeps {
  db: DatabaseSync;
  vault: {
    encrypt: (plain: string, aad: string) => string;
    decrypt: (cipher: string, aad: string) => string;
    hash: (value: string) => string;
  };
  cfg: () => Record<string, any>;
  hasTotp: (userId: string) => boolean;
  requireRecent: (r: Request, ctx: RequestContext) => string;
  sessionHash: (r: Request) => string;
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
  enabledUser: (id: string) => Promise<any>;
  safeJson: (v: unknown, status?: number) => Response;
  api: (
    method: string,
    path: string,
    access: string,
    handle: (r: Request, ctx: RequestContext) => Response | Promise<Response>,
  ) => void;
}

export function createTotpTools(deps: TotpDeps) {
  const { db, vault } = deps;

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

  deps.api("POST", "/totp/setup", "authenticated", async (r, ctx) => {
    const id = deps.requireRecent(r, ctx);
    if (deps.hasTotp(id))
      throw new HostError("already_enabled", "TOTP is already enabled", 409);
    const secret = base32(randomBytes(20));
    db.prepare(
      "DELETE FROM auth_challenges WHERE kind='totp' AND user_id=?",
    ).run(id);
    const token = deps.challenge("totp", {
      userId: id,
      secret: vault.encrypt(secret, "totp:" + id),
      binding: deps.sessionHash(r),
    });
    const user = await deps.enabledUser(id);
    const issuer = String(deps.cfg().issuer ?? "PluHub"),
      uri =
        "otpauth://totp/" +
        encodeURIComponent(issuer + ":" + user.username) +
        "?secret=" +
        secret +
        "&issuer=" +
        encodeURIComponent(issuer) +
        "&algorithm=SHA1&digits=6&period=30";
    return deps.safeJson({
      challenge: token,
      secret,
      uri,
      qrDataURL: await QRCode.toDataURL(uri, { width: 240, margin: 2 }),
    });
  });

  deps.api("POST", "/totp/confirm", "authenticated", async (r, ctx) => {
    const id = deps.requireRecent(r, ctx),
      b = await readObject(r),
      row = deps.readChallenge(b.challenge, "totp", deps.sessionHash(r));
    if (row.user_id !== id)
      throw new HostError(
        "forbidden",
        "Challenge belongs to another user",
        403,
      );
    const step = matchTotp(vault.decrypt(row.secret, "totp:" + id), b.code, -1);
    if (step === undefined)
      throw new HostError("invalid_factor", "Invalid authenticator code", 401);
    if (deps.hasTotp(id))
      throw new HostError("already_enabled", "TOTP already enabled", 409);
    transaction(db, () => {
      deps.consume(row);
      db.prepare("INSERT INTO totp_credentials VALUES(?,?,?)").run(
        id,
        row.secret,
        step,
      );
      db.prepare("DELETE FROM sessions WHERE user_id=? AND hash<>?").run(
        id,
        deps.sessionHash(r),
      );
      db.prepare("UPDATE sessions SET auth_at=? WHERE hash=?").run(
        Date.now(),
        deps.sessionHash(r),
      );
    });
    return deps.safeJson({ ok: true, recoveryCodes: recoveryCodes(id) });
  });

  deps.api("DELETE", "/totp", "authenticated", async (r, ctx) => {
    const id = deps.requireRecent(r, ctx);
    transaction(db, () => {
      db.prepare("DELETE FROM totp_credentials WHERE user_id=?").run(id);
      db.prepare("DELETE FROM recovery_codes WHERE user_id=?").run(id);
      db.prepare("DELETE FROM auth_challenges WHERE user_id=?").run(id);
      db.prepare("DELETE FROM sessions WHERE user_id=? AND hash<>?").run(
        id,
        deps.sessionHash(r),
      );
    });
    return deps.safeJson({ ok: true });
  });

  deps.api("POST", "/recovery-codes", "authenticated", async (r, ctx) => {
    const id = deps.requireRecent(r, ctx);
    if (!deps.hasTotp(id))
      throw new HostError("not_enabled", "Enable TOTP first");
    return deps.safeJson({ recoveryCodes: recoveryCodes(id) });
  });

  return { factor, recoveryCodes };
}
