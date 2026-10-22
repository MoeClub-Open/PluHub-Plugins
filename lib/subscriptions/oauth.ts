import { responseObject } from "../ai/json-response.js";
import type { Host } from "@pluhub/sdk";
import { HostError } from "@pluhub/sdk";
import {
  subscriptionDefaults,
  type SubscriptionKind,
} from "../ai/subscription-auth.js";

export function oauthConfig(
  host: Host,
  kind: SubscriptionKind,
  settings = host.config(),
) {
  const overrides = (settings.oauth as any)?.[kind] ?? {};
  const config = { ...subscriptionDefaults[kind], ...overrides };
  for (const field of ["authorizeUrl", "tokenUrl"] as const) {
    const url = new URL(config[field]);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw new HostError(
        "invalid_config",
        "OAuth 端点应使用 HTTPS 且不包含查询参数",
      );
  }
  const redirect = new URL(config.redirectUri);
  if (
    redirect.username ||
    redirect.password ||
    redirect.hash ||
    (redirect.protocol !== "https:" &&
      !(
        redirect.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname)
      ))
  )
    throw new HostError(
      "invalid_config",
      "OAuth 回调应使用 HTTPS 或本地回环地址",
    );
  return config;
}
export { responseObject } from "../ai/json-response.js";
export async function tokenRequest(
  host: Host,
  kind: SubscriptionKind,
  fields: Record<string, string>,
  signal: AbortSignal,
) {
  const config = oauthConfig(host, kind);
  const body = { ...fields, client_id: config.clientId };
  if (config.clientSecretRef)
    (body as any).client_secret = host.secret(config.clientSecretRef);
  else if (kind === "antigravity")
    throw new HostError(
      "oauth_client_secret",
      "请先配置 Antigravity OAuth 客户端密钥引用",
      503,
    );
  const json = kind === "claude-subscription";
  const response = await host.call<Response>(
    "http.transport@1",
    {
      url: config.tokenUrl,
      publicOnly: true,
      headers: {
        "content-type": json
          ? "application/json"
          : "application/x-www-form-urlencoded",
      },
      body: json ? JSON.stringify(body) : new URLSearchParams(body).toString(),
    },
    signal,
  );
  if (!response.ok) {
    let invalid = response.status === 401 || response.status === 403;
    try {
      const error = await responseObject(response, signal);
      invalid ||= ["invalid_grant", "invalid_token"].includes(error.error);
    } catch {
      /* Never expose provider response bodies or credentials. */
    }
    throw new HostError(
      invalid ? "subscription_reauthorize" : "oauth_refresh_failed",
      invalid ? "订阅授权已失效，请重新授权" : "授权服务暂时不可用",
      invalid ? 503 : 502,
    );
  }
  return responseObject(response, signal);
}
