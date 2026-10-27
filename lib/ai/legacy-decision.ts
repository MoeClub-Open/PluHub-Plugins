import { HostError, requiredString, type Host } from "@pluhub/sdk";
import type { Upstream, Usage } from "@pluhub/contracts/ai";
import { rawBody } from "../http/body.js";
import { prepareBeforeGeneration, upstreamRejection } from "./rejection.js";
import { upstreamUrl } from "./upstream-interfaces.js";
import { upstreamKey } from "./upstream-key.js";
import { responseModel } from "./response-model.js";

/** Execute a native Luna or self-hosted Jev decision on an authorized connection.
 * The caller owns admission, settlement and the response parser.
 */
export async function requestLegacyDecision<T>(
  host: Host,
  kind: "luna" | "jev",
  upstream: Upstream,
  body: unknown,
  parse: (response: unknown) => T,
  signal: AbortSignal,
  timeoutMs = 3000,
): Promise<{ decision: T; usage?: Usage; upstreamModel?: string }> {
  const { url, payload } = prepareBeforeGeneration(() => ({
    url: upstreamUrl(
      requiredString(upstream.baseUrl, "upstream URL", 2048),
      kind === "luna" ? "/v1/decisions" : "/v1/decide",
    ).href,
    payload: JSON.stringify(body),
  }));
  const active = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  const key = upstream.credentialId || upstream.keyRef
    ? await prepareBeforeGeneration(() => upstreamKey(host, upstream, active))
    : undefined;
  const response = await host.call<Response>(
    "http.transport@1",
    {
      url,
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: payload,
      publicOnly: upstream.publicOnly,
    },
    active,
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw upstreamRejection(response.status);
  }
  let data: any;
  try {
    const bytes = await rawBody(
      new Request("http://decision-response", {
        method: "POST",
        body: response.body,
        duplex: "half",
        signal: active,
      } as RequestInit),
      1024 * 1024,
    );
    data = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (active.aborted) throw active.reason;
    throw new HostError("invalid_decision", "Invalid decision response", 502);
  }
  const input = data?.usage?.input_tokens;
  const output = data?.usage?.output_tokens;
  const usage = [input, output].every((value) => Number.isSafeInteger(value) && value >= 0)
    ? { input, output }
    : undefined;
  try {
    const decision = parse(data);
    const upstreamModel = responseModel("openai-chat", data);
    return {
      decision,
      ...(usage ? { usage } : {}),
      ...(upstreamModel ? { upstreamModel } : {}),
    };
  } catch (error) {
    // The response may be unusable even though the remote service incurred cost.
    if (usage && error instanceof Error) Object.assign(error, { usage });
    throw error;
  }
}
