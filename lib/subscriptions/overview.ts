import { HostError, type Host } from "@pluhub/sdk";
import type { SubscriptionQuota } from "@pluhub/contracts/subscription";
import {
  normalizeSubscriptionToken,
  type SubscriptionKind,
  type SubscriptionToken,
} from "../ai/subscription-auth.js";
import { responseObject } from "./oauth.js";

export const subscriptionNames: Record<SubscriptionKind, string> = {
  codex: "Codex",
  "claude-subscription": "Claude",
  antigravity: "Antigravity",
};
type Overview = {
  quota: SubscriptionQuota[];
  email?: string;
  plan?: string;
  credits?: { balance?: string; unlimited?: boolean };
};
const unavailable = () =>
  new HostError(
    "subscription_quota_unavailable",
    "无法查询订阅额度，请稍后重试",
    502,
  );
async function request(
  host: Host,
  url: string,
  token: SubscriptionToken,
  signal: AbortSignal,
  body?: unknown,
) {
  const headers: Record<string, string> = {
    authorization: "Bearer " + token.access_token,
    accept: "application/json",
  };
  if (url.startsWith("https://chatgpt.com/")) {
    if (token.account_id) headers["chatgpt-account-id"] = token.account_id;
    headers["openai-beta"] = "codex-1";
    headers.originator = "Codex Desktop";
  }
  if (url.startsWith("https://api.anthropic.com/")) {
    headers["anthropic-beta"] = "oauth-2025-04-20";
    headers["user-agent"] = "claude-code/2.1.7";
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await host.call<Response>(
      "http.transport@1",
      {
        url,
        publicOnly: true,
        headers,
        ...(body === undefined
          ? { method: "GET" }
          : { body: JSON.stringify(body) }),
      },
      signal,
    );
  } catch {
    signal.throwIfAborted();
    throw unavailable();
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401)
      throw new HostError(
        "subscription_reauthorize",
        "订阅授权已失效，请重新授权",
        401,
      );
    if (response.status === 403)
      throw new HostError(
        "subscription_quota_forbidden",
        "当前授权没有额度查询权限",
        403,
      );
    if (response.status === 429)
      throw new HostError(
        "subscription_quota_limited",
        "额度查询过于频繁，请稍后重试",
        429,
      );
    throw unavailable();
  }
  try {
    return await responseObject(response, signal, 1048576);
  } catch {
    signal.throwIfAborted();
    throw unavailable();
  }
}

/** Identity is display metadata; never use these claims to authenticate a PluHub user. */
export async function subscriptionIdentity(
  host: Host,
  kind: SubscriptionKind,
  raw: unknown,
  signal: AbortSignal,
) {
  const token = normalizeSubscriptionToken(raw);
  if (token.email || kind === "codex") return token;
  try {
    const profile = await request(
      host,
      kind === "antigravity"
        ? "https://www.googleapis.com/oauth2/v2/userinfo?alt=json"
        : "https://api.anthropic.com/api/oauth/profile",
      token,
      AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    );
    return normalizeSubscriptionToken({
      ...token,
      email: profile.email ?? profile.account?.email,
    });
  } catch {
    signal.throwIfAborted();
    return token;
  }
}

/** Queries account control-plane endpoints only; no inference or reset-credit redemption. */
export async function subscriptionOverview(
  host: Host,
  kind: SubscriptionKind,
  token: SubscriptionToken,
  signal: AbortSignal,
): Promise<Overview> {
  const now = Date.now();
  const quota: SubscriptionQuota[] = [];
  let plan: string | undefined,
    credits: Overview["credits"],
    email = token.email;
  const add = (
    window: string,
    used: unknown,
    reset?: unknown,
    minutes?: unknown,
    label?: string,
  ) => {
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0) return;
    const resetAt =
      typeof reset === "number"
        ? reset * 1000
        : typeof reset === "string"
          ? Date.parse(reset)
          : NaN;
    quota.push({
      window,
      usedPercent: Math.min(100, used),
      updatedAt: now,
      ...(Number.isFinite(resetAt) && resetAt > 0 ? { resetAt } : {}),
      ...(typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0
        ? { windowMinutes: minutes }
        : {}),
      ...(typeof label === "string" && label
        ? { label: label.slice(0, 256) }
        : {}),
    });
  };
  if (kind === "codex") {
    const data = await request(
      host,
      "https://chatgpt.com/backend-api/wham/usage",
      token,
      signal,
    );
    email = normalizeSubscriptionToken({
      ...token,
      email: data.email ?? token.email,
    }).email;
    if (typeof data.plan_type === "string") plan = data.plan_type.slice(0, 128);
    const limits = (value: any, prefix = "", label?: string) => {
      for (const window of ["primary", "secondary"])
        if (value?.[window + "_window"]) {
          const item = value[window + "_window"];
          add(
            prefix + window,
            item.used_percent,
            item.reset_at ??
              (typeof item.reset_after_seconds === "number"
                ? now / 1000 + item.reset_after_seconds
                : undefined),
            typeof item.limit_window_seconds === "number"
              ? item.limit_window_seconds / 60
              : undefined,
            label,
          );
        }
    };
    limits(data.rate_limit);
    if (Array.isArray(data.additional_rate_limits))
      data.additional_rate_limits.forEach((item: any, index: number) =>
        limits(
          item.rate_limit,
          "additional:" + index + ":",
          item.limit_name ?? item.metered_feature,
        ),
      );
    if (data.code_review_rate_limit)
      limits(data.code_review_rate_limit, "review:", "Code review");
    if (data.credits && typeof data.credits === "object") {
      const balance = data.credits.balance;
      credits = {
        ...(typeof balance === "string" &&
        /^-?\d+(\.\d+)?$/.test(balance) &&
        balance.length <= 128
          ? { balance }
          : {}),
        ...(typeof data.credits.unlimited === "boolean"
          ? { unlimited: data.credits.unlimited }
          : {}),
      };
      if (credits.balance === undefined && credits.unlimited !== true)
        credits = undefined;
    }
  } else if (kind === "claude-subscription") {
    const data = await request(
      host,
      "https://api.anthropic.com/api/oauth/usage",
      token,
      signal,
    );
    for (const [window, item] of Object.entries(data) as [string, any][])
      if (window === "five_hour" || window.startsWith("seven_day"))
        add(
          window,
          item?.utilization,
          item?.resets_at,
          window === "five_hour" ? 300 : 10080,
          window === "five_hour" || window === "seven_day"
            ? undefined
            : window.replace(/^seven_day_/, "").replaceAll("_", " "),
        );
  } else {
    let project = token.project_id;
    if (!project) {
      const data = await request(
        host,
        "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
        token,
        signal,
        { metadata: { ideType: "ANTIGRAVITY" } },
      );
      project =
        typeof data.cloudaicompanionProject === "string"
          ? data.cloudaicompanionProject
          : data.cloudaicompanionProject?.id;
    }
    if (!project)
      throw new HostError(
        "project_discovery",
        "项目发现失败，请手动填写 Project ID",
        400,
      );
    const data = await request(
      host,
      "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
      token,
      signal,
      { project },
    );
    for (const [model, item] of Object.entries(data.models ?? {}) as [
      string,
      any,
    ][])
      if (
        typeof item?.quotaInfo?.remainingFraction === "number" &&
        item.quotaInfo.remainingFraction >= 0 &&
        item.quotaInfo.remainingFraction <= 1
      )
        add(
          "model:" + model,
          (1 - item.quotaInfo.remainingFraction) * 100,
          item.quotaInfo.resetTime,
          undefined,
          item.displayName ?? model,
        );
  }
  if (!quota.length && !credits)
    throw new HostError(
      "subscription_quota_unknown",
      "提供商未返回订阅额度",
      502,
    );
  if (!email)
    email = (await subscriptionIdentity(host, kind, token, signal)).email;
  return {
    quota,
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
    ...(credits ? { credits } : {}),
  };
}
