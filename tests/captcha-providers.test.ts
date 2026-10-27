import { it, expect } from "vitest";
import {
  captchaOptions,
  prepareChallenge,
  validateCaptchaConfig,
} from "../plugins/turnstile/providers.js";

it("binds hCaptcha tokens to the configured sitekey without treating hostname as authentication", () => {
  const config = {
    enabled: true,
    provider: "hcaptcha",
    siteKey: "site",
    secretRef: "secret:CAPTCHA",
  };
  expect(() => validateCaptchaConfig(config)).not.toThrow();
  expect(captchaOptions(config)).toEqual({
    enabled: true,
    provider: "hcaptcha",
    siteKey: "site",
  });
  const challenge = prepareChallenge(
    config,
    { token: "token+with/reserved=chars", action: "register" },
    "secret&value",
  );
  const fields = new URLSearchParams(challenge.request.body);
  expect(Object.fromEntries(fields)).toEqual({
    response: "token+with/reserved=chars",
    secret: "secret&value",
    sitekey: "site",
  });
  const now = Date.now();
  const response = {
    success: true,
    hostname: "not-provided",
    challenge_ts: new Date(now).toISOString(),
  };
  expect(() => challenge.validate(response, now)).not.toThrow();
  expect(() =>
    challenge.validate({ ...response, success: false }, now),
  ).toThrow();
  expect(() =>
    challenge.validate(
      { success: false, "error-codes": ["expired-input-response"] },
      now,
    ),
  ).toThrow();
  expect(() => validateCaptchaConfig({ ...config, secretRef: "" })).toThrow();
});

it("checks reCAPTCHA v3 action and score while retaining reCAPTCHA v2 checkbox support", () => {
  const config = {
    enabled: true,
    provider: "recaptcha",
    siteKey: "site",
    hostnames: ["example.com"],
    recaptchaVersion: "v3",
    minScore: 0.6,
  };
  const challenge = prepareChallenge(
    config,
    { token: "token", action: "email" },
    "secret",
  );
  const now = Date.now();
  const response = {
    success: true,
    hostname: "example.com",
    challenge_ts: new Date(now).toISOString(),
    action: "email",
    score: 0.8,
  };
  expect(() => challenge.validate(response, now)).not.toThrow();
  for (const patch of [
    { action: "login" },
    { score: 0.5 },
    { hostname: "evil.test" },
  ])
    expect(() => challenge.validate({ ...response, ...patch }, now)).toThrow();
  const v2 = prepareChallenge(
    { ...config, recaptchaVersion: "v2" },
    { token: "checkbox-token", action: "email" },
    "secret",
  );
  expect(() =>
    v2.validate({ ...response, action: undefined, score: undefined }, now),
  ).not.toThrow();
});
