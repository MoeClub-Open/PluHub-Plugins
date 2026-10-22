import { it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  base32,
  totp,
  matchTotp,
  authVault,
} from "../plugins/auth/security/crypto.js";
import { emailAddress } from "../lib/identity/email.js";
import plugin from "../plugins/turnstile/index.js";

it("matches RFC 6238 SHA-1 vectors and enforces time windows and one-time counters", () => {
  const secret = base32(Buffer.from("12345678901234567890"));
  for (const [time, expected] of [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ] as const)
    expect(totp(secret, Math.floor(time / 30), 8)).toBe(expected);
  const now = 1234567890000,
    counter = Math.floor(now / 30000),
    code = totp(secret, counter);
  expect(matchTotp(secret, code, counter - 1, now)).toBe(counter);
  expect(matchTotp(secret, code, counter, now)).toBeUndefined();
  expect(matchTotp(secret, totp(secret, counter - 2), -1, now)).toBeUndefined();
  expect(matchTotp(secret, "12345", -1, now)).toBeUndefined();
});
it("encrypts TOTP secrets with authenticated user binding and persists the key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pluhub-auth-crypto-"));
  try {
    const a = authVault(dir),
      sealed = a.encrypt("secret", "totp:alice");
    expect(() => authVault(join(dir, "missing"), true)).toThrow(
      "encryption key is missing",
    );
    expect(sealed).not.toContain("secret");
    expect(() => a.decrypt(sealed, "totp:bob")).toThrow();
    const hash = a.hash("proof");
    a.close();
    const b = authVault(dir);
    expect(b.decrypt(sealed, "totp:alice")).toBe("secret");
    expect(b.hash("proof")).toBe(hash);
    b.close();
    if (process.platform !== "win32")
      expect((await stat(join(dir, "security.key"))).mode & 0o777).toBe(0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("rejects email header injection and normalizes application email identities", () => {
  expect(emailAddress("Alice@Example.COM")).toBe("alice@example.com");
  for (const value of [
    "a@example.com\r\nBcc: x@evil.test",
    "Name <a@example.com>",
    "a b@example.com",
    "a@localhost",
  ])
    expect(() => emailAddress(value)).toThrow();
});
it("validates Turnstile action, hostname, age, replay and bounded responses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pluhub-turnstile-")),
    handlers = new Map<string, any>(),
    cleanups: (() => any)[] = [];
  let data: any = {
      success: true,
      hostname: "hub.example",
      action: "login",
      challenge_ts: new Date().toISOString(),
    },
    raw: string | undefined,
    validation: any;
  const config = {
    enabled: true,
    siteKey: "public",
    secretRef: "env:SECRET",
    hostnames: ["hub.example"],
  };
  try {
    plugin.setup({
      dataDir: dir,
      config: () => config,
      cleanup: (f: any) => cleanups.push(f),
      validateConfig: (f: any) => (validation = f),
      provide: (n: string, f: any) => handlers.set(n, f),
      api: () => {},
      secret: () => "private-server-key",
      call: async (_n: string, i: any) => {
        expect(i.url).toBe(
          "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        );
        expect(JSON.parse(i.body).secret).toBe("private-server-key");
        return new Response(raw ?? JSON.stringify(data));
      },
    } as any);
    validation(config);
    const verify = (token: string) =>
      handlers.get("captcha.verify@1")(
        { token, action: "login" },
        new AbortController().signal,
      );
    expect(handlers.get("captcha.options@1")()).toEqual({
      enabled: true,
      siteKey: "public",
    });
    expect(await verify("valid")).toBe(true);
    await expect(verify("valid")).rejects.toMatchObject({
      code: "captcha_failed",
    });
    for (const patch of [
      { hostname: "evil.example" },
      { action: "register" },
      { success: false },
      { challenge_ts: new Date(Date.now() - 301000).toISOString() },
      { challenge_ts: "bad" },
    ]) {
      data = {
        success: true,
        hostname: "hub.example",
        action: "login",
        challenge_ts: new Date().toISOString(),
        ...patch,
      };
      await expect(verify(JSON.stringify(patch))).rejects.toMatchObject({
        code: "captcha_failed",
      });
    }
    raw = "x".repeat(70000);
    await expect(verify("oversize")).rejects.toMatchObject({
      code: "captcha_unavailable",
    });
    config.enabled = false;
    await expect(verify("disabled")).rejects.toMatchObject({
      code: "captcha_unavailable",
    });
  } finally {
    for (const close of cleanups) close();
    await rm(dir, { recursive: true, force: true });
  }
});
