import { HostError, type Host } from "@pluhub/sdk";
import type { Upstream } from "@pluhub/contracts/ai";
import { SelectionPool } from "./selection.js";

const pool = new SelectionPool();
export function keyReferences(value: Upstream["keyRef"]): string[] {
  return [
    ...new Set(
      (Array.isArray(value) ? value : value ? [value] : [])
        .map((key) => key.trim())
        .filter(Boolean),
    ),
  ];
}
export function splitKeys(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n/)
        .map((key) => key.trim())
        .filter(Boolean),
    ),
  ];
}
export async function upstreamKey(
  host: Host,
  upstream: Upstream,
  signal: AbortSignal,
  sessionId?: string,
): Promise<string> {
  if (upstream.credentialId)
    return (
      await host.call<{ secret: string }>(
        "credentials.resolve@1",
        {
          id: upstream.credentialId,
          userId: upstream.credentialOwner,
          sessionId,
        },
        signal,
      )
    ).secret;
  const refs = keyReferences(upstream.keyRef);
  const scope = JSON.stringify([upstream.protocol, upstream.baseUrl, refs]);
  const ref = pool.choose(scope, refs, (key) => key, sessionId);
  if (!ref) throw new HostError("credential_required", "请配置上游密钥");
  return host.secret(ref);
}
