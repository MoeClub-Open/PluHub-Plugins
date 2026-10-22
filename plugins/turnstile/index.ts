import { join } from "node:path";
import type { CaptchaVerification } from "@pluhub/contracts/security";
import { createHash } from "node:crypto";
import { definePlugin, HostError, json, requiredString } from "@pluhub/sdk";
import { openDatabase } from "../../lib/storage/sqlite.js";
import { rawBody } from "../../lib/http/body.js";
export default definePlugin({
  setup(host) {
    const db = openDatabase(join(host.dataDir, "turnstile.sqlite"), [
      "CREATE TABLE used_tokens(hash TEXT PRIMARY KEY,expires INTEGER NOT NULL);",
    ]);
    host.cleanup(() => db.close());
    host.validateConfig((c) => {
      if (
        c.enabled &&
        (!c.siteKey ||
          !c.secretRef ||
          !((c.hostnames ?? []) as string[]).length)
      )
        throw new HostError(
          "invalid_config",
          "Turnstile requires a site key, secret reference and explicit hostnames",
        );
    });
    host.provide("captcha.options@1", () => ({
      enabled: host.config().enabled === true,
      ...(host.config().enabled ? { siteKey: host.config().siteKey } : {}),
    }));
    host.provide(
      "captcha.verify@1",
      async (input: CaptchaVerification, signal) => {
        const c = host.config();
        if (!c.enabled)
          throw new HostError(
            "captcha_unavailable",
            "Turnstile is not enabled",
            503,
          );
        const token = requiredString(input.token, "turnstileToken", 2048),
          action = requiredString(input.action, "action", 32);
        if (!/^[a-z0-9_-]+$/.test(action))
          throw new HostError("invalid_request", "Invalid challenge action");
        const hash = createHash("sha256").update(token).digest("hex"),
          now = Date.now();
        db.prepare("DELETE FROM used_tokens WHERE expires<?").run(now);
        if (db.prepare("SELECT 1 FROM used_tokens WHERE hash=?").get(hash))
          throw new HostError(
            "captcha_failed",
            "Complete a new verification challenge",
            400,
          );
        const active = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
        let data: any;
        try {
          const response = await host.call<Response>(
            "http.transport@1",
            {
              url: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                secret: host.secret(String(c.secretRef)),
                response: token,
              }),
            },
            active,
          );
          if (!response.ok) {
            await response.body?.cancel();
            throw Error("siteverify");
          }
          const bytes = await rawBody(
            new Request("http://turnstile-response", {
              method: "POST",
              body: response.body,
              duplex: "half",
              signal: active,
            } as RequestInit),
            65536,
          );
          data = JSON.parse(bytes.toString());
        } catch {
          signal.throwIfAborted();
          throw new HostError(
            "captcha_unavailable",
            "Verification service unavailable; try again",
            503,
          );
        }
        const timestamp = Date.parse(data.challenge_ts);
        if (
          data.success !== true ||
          data.action !== action ||
          !(c.hostnames as string[]).includes(data.hostname) ||
          !Number.isFinite(timestamp) ||
          timestamp < now - 300000 ||
          timestamp > now + 30000
        )
          throw new HostError(
            "captcha_failed",
            "Verification failed; complete a new challenge",
            400,
          );
        try {
          db.prepare("INSERT INTO used_tokens VALUES(?,?)").run(
            hash,
            now + 300000,
          );
        } catch {
          throw new HostError("captcha_failed", "Challenge already used", 400);
        }
        return true;
      },
    );
    host.api({
      method: "GET",
      path: "/status",
      access: "host.manage",
      handle: () => json({ config: host.config() }),
    });
  },
});
