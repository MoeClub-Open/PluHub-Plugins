import { join } from "node:path";
import type { CaptchaVerification } from "@pluhub/contracts/security";
import { createHash } from "node:crypto";
import { definePlugin, HostError, json } from "@pluhub/sdk";
import { openDatabase } from "../../lib/storage/sqlite.js";
import { rawBody } from "../../lib/http/body.js";
import {
  captchaOptions,
  prepareChallenge,
  validateCaptchaConfig,
} from "./providers.js";
export default definePlugin({
  setup(host) {
    const db = openDatabase(join(host.dataDir, "turnstile.sqlite"), [
      "CREATE TABLE used_tokens(hash TEXT PRIMARY KEY,expires INTEGER NOT NULL);",
    ]);
    host.cleanup(() => db.close());
    host.validateConfig(validateCaptchaConfig);
    host.provide("captcha.options@1", () => captchaOptions(host.config()));
    host.provide(
      "captcha.verify@1",
      async (input: CaptchaVerification, signal) => {
        const c = host.config();
        if (!c.enabled)
          throw new HostError(
            "captcha_unavailable",
            "Verification service is not enabled",
            503,
          );
        const challenge = prepareChallenge(
          c,
          input,
          host.secret(String(c.secretRef)),
        );
        const hash = createHash("sha256")
            .update(challenge.identity)
            .digest("hex"),
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
            challenge.request,
            active,
          );
          if (!response.ok) {
            await response.body?.cancel();
            throw Error("siteverify");
          }
          const bytes = await rawBody(
            new Request("http://captcha-response", {
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
        challenge.validate(data, Date.now());
        try {
          db.prepare("INSERT INTO used_tokens VALUES(?,?)").run(
            hash,
            Date.now() + challenge.maxAge,
          );
        } catch {
          throw new HostError(
            "captcha_failed",
            "Complete a new verification challenge",
            400,
          );
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
