import { createHmac } from "node:crypto";
import { HostError, requiredString } from "@pluhub/sdk";
import type {
  CaptchaOptions,
  CaptchaVerification,
} from "@pluhub/contracts/security";

type Config = Record<string, any>;
export function captchaOptions(config: Config): CaptchaOptions {
  const provider = config.provider ?? "turnstile";
  return {
    enabled: config.enabled === true,
    provider,
    ...(config.enabled ? { siteKey: config.siteKey } : {}),
    ...(provider === "recaptcha"
      ? {
          recaptchaVersion: config.recaptchaVersion ?? "v2",
          recaptchaDomain: config.recaptchaDomain ?? "www.google.com",
        }
      : {}),
  };
}
export function validateCaptchaConfig(config: Config) {
  if (
    config.enabled &&
    (!config.siteKey ||
      !config.secretRef ||
      ((config.provider ?? "turnstile") !== "geetest" &&
        !config.hostnames?.length))
  )
    throw new HostError("invalid_config", "请填写验证服务所需的密钥与站点配置");
}
const failed = (): never => {
  throw new HostError(
    "captcha_failed",
    "Verification failed; complete a new challenge",
    400,
  );
};

/** Only provider-owned endpoints are used; neither credentials nor client payloads can change them. */
export function prepareChallenge(
  config: Config,
  input: CaptchaVerification,
  secret: string,
) {
  const provider = config.provider ?? "turnstile";
  const action = requiredString(input.action, "action", 32);
  const token = requiredString(
    input.token,
    "captchaToken",
    provider === "turnstile" ? 2048 : 16384,
  );
  if (!/^[a-z0-9_-]+$/.test(action))
    throw new HostError("invalid_request", "Invalid challenge action");
  let url: string,
    body: string,
    json = false,
    identity = token;
  if (provider === "geetest") {
    let value: any;
    try {
      value = JSON.parse(token);
    } catch {
      failed();
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) failed();
    const fields = Object.fromEntries(
      ["lot_number", "captcha_output", "pass_token", "gen_time"].map((key) => [
        key,
        requiredString(value[key], key, key === "gen_time" ? 20 : 8192),
      ]),
    );
    if (value.captcha_id && value.captcha_id !== config.siteKey) failed();
    identity = fields.lot_number;
    url =
      "https://gcaptcha4.geetest.com/validate?captcha_id=" +
      encodeURIComponent(config.siteKey);
    body = new URLSearchParams({
      ...fields,
      sign_token: createHmac("sha256", secret)
        .update(fields.lot_number)
        .digest("hex"),
    }).toString();
  } else if (provider === "recaptcha") {
    const domain =
      config.recaptchaDomain === "www.recaptcha.net"
        ? "www.recaptcha.net"
        : "www.google.com";
    url = `https://${domain}/recaptcha/api/siteverify`;
    body = new URLSearchParams({ secret, response: token }).toString();
  } else {
    url = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
    json = true;
    body = JSON.stringify({ secret, response: token });
  }
  const maxAge = provider === "recaptcha" ? 120000 : 300000;
  return {
    identity: JSON.stringify([provider, config.siteKey, identity]),
    maxAge,
    request: {
      url,
      publicOnly: true,
      body,
      headers: {
        "content-type": json
          ? "application/json"
          : "application/x-www-form-urlencoded",
      },
    },
    validate(data: any, now: number) {
      if (!data || typeof data !== "object") failed();
      if (provider === "geetest") {
        if (
          data.result !== "success" ||
          data.status === "error" ||
          (data.captcha_args?.lot_number &&
            data.captcha_args.lot_number !== identity)
        )
          failed();
        return;
      }
      const timestamp = Date.parse(data.challenge_ts);
      if (
        data.success !== true ||
        !config.hostnames?.includes(data.hostname) ||
        !Number.isFinite(timestamp) ||
        timestamp < now - maxAge ||
        timestamp > now + 30000
      )
        failed();
      if (provider === "turnstile" && data.action !== action) failed();
      if (
        provider === "recaptcha" &&
        config.recaptchaVersion === "v3" &&
        (data.action !== action ||
          typeof data.score !== "number" ||
          !Number.isFinite(data.score) ||
          data.score < (config.minScore ?? 0.5) ||
          data.score > 1)
      )
        failed();
    },
  };
}
