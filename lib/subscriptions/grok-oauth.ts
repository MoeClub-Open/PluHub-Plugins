import { HostError, type Host } from "@pluhub/sdk";
import { responseObject } from "../ai/json-response.js";

export const grokClientId = "b1a00492-073a-47ea-816f-4c329264a828";
export const grokScope =
  "openid profile email offline_access grok-cli:access api:access";
const endpoint = (value: string) => {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !(url.hostname === "x.ai" || url.hostname.endsWith(".x.ai")) ||
    url.username ||
    url.password
  )
    throw new HostError(
      "oauth_response",
      "Invalid xAI authorization endpoint",
      502,
    );
  return url.href;
};
export async function grokDiscovery(host: Host, signal: AbortSignal) {
  const response = await host.call<Response>(
    "http.transport@1",
    {
      url: "https://auth.x.ai/.well-known/openid-configuration",
      method: "GET",
      publicOnly: true,
    },
    signal,
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new HostError(
      "oauth_unavailable",
      "xAI authorization unavailable",
      502,
    );
  }
  const data = await responseObject(response, signal);
  return {
    device: endpoint(data.device_authorization_endpoint),
    token: endpoint(data.token_endpoint),
  };
}
export async function grokDeviceRequest(
  host: Host,
  url: string,
  fields: Record<string, string>,
  signal: AbortSignal,
) {
  const response = await host.call<Response>(
    "http.transport@1",
    {
      url: endpoint(url),
      publicOnly: true,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: grokClientId,
        ...fields,
      }).toString(),
    },
    signal,
  );
  const data = await responseObject(response, signal);
  if (
    !response.ok &&
    !["authorization_pending", "slow_down"].includes(data.error)
  )
    throw new HostError(
      "oauth_device_failed",
      "Grok authorization failed; start again",
      502,
    );
  return data;
}
