import { HostError } from "@pluhub/sdk";
import type { SubscriptionQuota } from "@pluhub/contracts/subscription";

export type SubscriptionKind =
  "codex" | "claude-subscription" | "antigravity" | "grok";
export const subscriptionDefaults = {
  grok: {
    baseUrl: "https://cli-chat-proxy.grok.com/v1",
    authorizeUrl: "https://auth.x.ai/authorize",
    tokenUrl: "https://auth.x.ai/token",
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    redirectUri: "http://127.0.0.1:1456/auth/callback",
    scope: "openid profile email offline_access grok-cli:access api:access",
  },
  codex: {
    baseUrl: "https://chatgpt.com/backend-api/codex",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    redirectUri: "http://localhost:1455/auth/callback",
    scope: "openid email profile offline_access",
  },
  "claude-subscription": {
    baseUrl: "https://api.anthropic.com",
    authorizeUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://platform.claude.com/v1/oauth/token",
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    redirectUri: "http://localhost:54545/callback",
    scope:
      "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
  },
  antigravity: {
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientId:
      "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    redirectUri: "http://localhost:51121/oauth-callback",
    scope:
      "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs",
  },
} as const;
export function subscriptionKind(value: unknown): SubscriptionKind {
  if (typeof value !== "string" || !Object.hasOwn(subscriptionDefaults, value))
    throw new HostError("invalid_subscription", "无效的订阅提供商");
  return value as SubscriptionKind;
}
export interface SubscriptionToken {
  auth_mode?: "siwc";
  client_id?: string;
  ext_agent_host_id?: string;
  id_token?: string;
  subject?: string;
  scopes?: string[];
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  account_id?: string;
  project_id?: string;
  email?: string;
  plan_type?: string;
  credits?: { balance?: string; unlimited?: boolean };
}
/** A passive snapshot from actual requests; absent headers never imply zero usage. */
export function subscriptionQuota(
  kind: SubscriptionKind,
  headers: Headers,
  now = Date.now(),
): SubscriptionQuota[] {
  if (kind === "grok") {
    return ["requests", "tokens"].flatMap((window) => {
      const read = (field: string) =>
        headers.get(`x-ratelimit-${field}-${window}`) ??
        headers.get(`x-rate-limit-${field}-${window}`);
      const limit = read("limit"),
        remaining = read("remaining"),
        reset = read("reset");
      if (
        !limit ||
        !remaining ||
        !Number.isFinite(Number(limit)) ||
        Number(limit) <= 0 ||
        !Number.isFinite(Number(remaining))
      )
        return [];
      const resetAt =
        reset && /^\d+(\.\d+)?$/.test(reset)
          ? Number(reset) * 1000
          : reset
            ? Date.parse(reset)
            : NaN;
      return [
        {
          window,
          usedPercent: Math.max(
            0,
            Math.min(100, (1 - Number(remaining) / Number(limit)) * 100),
          ),
          ...(Number.isFinite(resetAt) ? { resetAt } : {}),
        },
      ];
    });
  }
  if (kind !== "codex") return [];
  const result: SubscriptionQuota[] = [];
  for (const window of ["primary", "secondary"] as const) {
    const prefix = "x-codex-" + window + "-",
      raw = headers.get(prefix + "used-percent");
    if (!raw?.trim()) continue;
    const usedPercent = Number(raw);
    if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100)
      continue;
    const reset = headers.get(prefix + "reset-after-seconds"),
      minutes = headers.get(prefix + "window-minutes");
    result.push({
      window,
      usedPercent,
      ...(reset?.trim() &&
      Number.isFinite(Number(reset)) &&
      Number(reset) >= 0 &&
      Number(reset) <= 2592000
        ? { resetAt: now + Number(reset) * 1000 }
        : {}),
      ...(minutes?.trim() &&
      Number.isFinite(Number(minutes)) &&
      Number(minutes) > 0 &&
      Number(minutes) <= 44640
        ? { windowMinutes: Number(minutes) }
        : {}),
    });
  }
  return result;
}
function text(value: unknown, max = 32768): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > max || /[\r\n\0]/.test(value))
    throw new HostError("invalid_credential", "授权字段格式无效");
  return value.trim() || undefined;
}
function object(value: any): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HostError("invalid_credential", "每次请导入一个账号的授权");
  return value;
}
// JWT claims are metadata hints only. They never establish a PluHub identity.
function claims(token?: string): Record<string, any> {
  try {
    return object(
      JSON.parse(Buffer.from(token!.split(".")[1]!, "base64url").toString()),
    );
  } catch {
    return {};
  }
}
export function normalizeSubscriptionToken(
  input: unknown,
  now = Date.now(),
): SubscriptionToken {
  let raw: any = input;
  if (typeof raw === "string") {
    if (raw.length > 131072)
      throw new HostError("invalid_credential", "授权内容过大");
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new HostError("invalid_credential", "授权 JSON 格式无效");
    }
  }
  const root = object(raw);
  const value = object(
    root.tokens ?? root.claudeAiOauth ?? root.credentials ?? root,
  );
  if (value.client_id && value.ext_agent_host_id && value.id_token)
    value.auth_mode = "siwc";
  const access_token = text(value.access_token ?? value.accessToken);
  const refresh_token = text(value.refresh_token ?? value.refreshToken);
  if (!access_token && !refresh_token)
    throw new HostError("invalid_credential", "需要访问令牌或刷新令牌");
  const jwt = claims(access_token),
    identity = claims(text(value.id_token));
  const auth =
    jwt["https://api.openai.com/auth"] ??
    identity["https://api.openai.com/auth"] ??
    {};
  const email =
    value.email ??
    root.email ??
    value.account?.email_address ??
    value.account?.email ??
    identity.email ??
    jwt.email ??
    jwt["https://api.openai.com/profile"]?.email;
  const plan = value.plan_type ?? root.plan_type ?? auth.chatgpt_plan_type;
  let expiry: any = value.expires_at ?? value.expiresAt ?? value.expiry_date;
  if (expiry === undefined && value.expires_in !== undefined) {
    if (
      !Number.isFinite(Number(value.expires_in)) ||
      Number(value.expires_in) <= 0
    )
      throw new HostError("invalid_credential", "令牌有效期无效");
    expiry = now + Number(value.expires_in) * 1000;
  } else if (expiry === undefined && Number.isFinite(jwt.exp))
    expiry = jwt.exp * 1000;
  else if (typeof expiry === "string" && !/^\d+(\.\d+)?$/.test(expiry))
    expiry = Date.parse(expiry);
  else if (expiry !== undefined) {
    expiry = Number(expiry);
    if (expiry < 100000000000) expiry *= 1000;
  }
  if (
    expiry !== undefined &&
    (!Number.isSafeInteger(expiry) || expiry < 0 || expiry > 8640000000000000)
  )
    throw new HostError("invalid_credential", "令牌到期时间无效");
  return {
    ...(value.auth_mode === "siwc"
      ? {
          auth_mode: "siwc" as const,
          client_id: text(value.client_id, 512),
          ext_agent_host_id: text(value.ext_agent_host_id, 512),
          id_token: text(value.id_token),
          subject: text(value.subject, 512),
          scopes: Array.isArray(value.scopes)
            ? value.scopes.filter((s: unknown) => typeof s === "string")
            : [],
        }
      : {}),
    access_token,
    refresh_token,
    expires_at: expiry,
    account_id: text(
      value.account_id ?? value.accountId ?? auth.chatgpt_account_id,
      512,
    ),
    project_id: text(value.project_id ?? value.projectId, 512),
    ...(typeof email === "string" &&
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+$/.test(email.trim())
      ? { email: email.trim() }
      : {}),
    ...(typeof plan === "string" && plan.length <= 128 && !/[\r\n\0]/.test(plan)
      ? { plan_type: plan.trim() }
      : {}),
  };
}
