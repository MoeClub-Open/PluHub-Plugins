import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalJWKSet, jwtVerify } from "jose";
import { HostError, type Host } from "@pluhub/sdk";
import type { SubscriptionToken } from "../ai/subscription-auth.js";
import { responseObject } from "../ai/json-response.js";

export const siwcProfile = {
  authorizeUrl: "https://auth.openai.com/api/accounts/authorize",
  tokenUrl: "https://auth.openai.com/api/accounts/oauth/token",
  clientId: "dynamic_agent_client",
  redirectUri: "http://127.0.0.1:1455/auth/callback",
  scope:
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
};
export const siwcResource = "https://api.openai.com/v1";
export function siwcHostId(host: Host) {
  const file = join(host.dataDir, "siwc-host-id");
  try {
    return readFileSync(file, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const id = "urn:uuid:" + randomUUID();
    writeFileSync(file, id, { mode: 0o600, flag: "wx" });
    return id;
  }
}
async function read(host: Host, url: string, signal: AbortSignal) {
  const parsed = new URL(url);
  if (
    parsed.origin !== "https://auth.openai.com" ||
    parsed.username ||
    parsed.password
  )
    throw new HostError(
      "oauth_response",
      "Invalid OpenAI discovery endpoint",
      502,
    );
  const response = await host.call<Response>(
    "http.transport@1",
    { url, method: "GET", publicOnly: true },
    signal,
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new HostError(
      "oauth_unavailable",
      "OpenAI discovery unavailable",
      502,
    );
  }
  return responseObject(response, signal);
}
export async function verifySiwc(
  host: Host,
  raw: any,
  clientId: string,
  signal: AbortSignal,
  nonce?: string,
  previous?: SubscriptionToken,
) {
  if (
    !clientId ||
    clientId === siwcProfile.clientId ||
    typeof raw.id_token !== "string"
  )
    throw new HostError(
      "oauth_registration",
      "SIWC registration or ID token missing",
    );
  const discovery = await read(
    host,
    "https://auth.openai.com/.well-known/openid-configuration",
    signal,
  );
  const keys = await read(host, discovery.jwks_uri, signal);
  let payload;
  try {
    ({ payload } = await jwtVerify(
      raw.id_token,
      createLocalJWKSet(keys as any),
      {
        issuer: "https://auth.openai.com",
        audience: clientId,
        algorithms: ["RS256"],
        requiredClaims: ["sub", "exp", "iat"],
      },
    ));
  } catch {
    throw new HostError("oauth_identity", "SIWC identity verification failed");
  }
  if (
    (nonce && payload.nonce !== nonce) ||
    (previous?.subject && payload.sub !== previous.subject) ||
    (previous?.client_id && previous.client_id !== clientId)
  )
    throw new HostError(
      "oauth_identity",
      "SIWC account does not match this authorization",
    );
  const scopes =
    typeof raw.scope === "string" ? raw.scope.split(/\s+/) : raw.scopes;
  if (!Array.isArray(scopes) || !scopes.includes("chatgpt.tokens.use.direct"))
    throw new HostError("oauth_scope", "ChatGPT plan usage was not authorized");
  return {
    ...raw,
    auth_mode: "siwc",
    client_id: clientId,
    ext_agent_host_id: siwcHostId(host),
    subject: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    scopes,
  };
}
export async function revokeSiwc(
  host: Host,
  token: SubscriptionToken,
  signal: AbortSignal,
) {
  const discovery = await read(
    host,
    "https://auth.openai.com/.well-known/openid-configuration",
    signal,
  );
  const url = new URL(discovery.revocation_endpoint);
  if (url.origin !== "https://auth.openai.com")
    throw new HostError("oauth_response", "Invalid revocation endpoint");
  const response = await host.call<Response>(
    "http.transport@1",
    {
      url: url.href,
      publicOnly: true,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: token.refresh_token ?? token.access_token!,
        token_type_hint: token.refresh_token ? "refresh_token" : "access_token",
        client_id: token.client_id!,
      }).toString(),
    },
    signal,
  );
  await response.body?.cancel();
  return response.ok;
}
