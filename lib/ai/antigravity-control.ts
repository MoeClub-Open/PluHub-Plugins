import { HostError, type Host } from "@pluhub/sdk";
import { responseObject } from "./json-response.js";

const endpoints = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
] as const;
const version = "2.24.0";
const changelist = "1000335682";

export const antigravityUserAgent =
  `antigravity/hub/${version} (aidev_client; os_type=darwin; arch=arm64; cl=${changelist})`;

const onboardUserAgent = antigravityUserAgent + " google-api-nodejs-client/10.3.0";

type AttemptError = Error & { status?: number };

function attemptError(status?: number): AttemptError {
  const error = new Error("Antigravity control request failed") as AttemptError;
  error.status = status;
  return error;
}

function projectId(value: unknown, directId = false): string | undefined {
  if (typeof value === "string") {
    const result = value.trim();
    return result && result.length <= 512 && !/[\r\n\0]/.test(result)
      ? result
      : undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const item = value as Record<string, unknown>;
  for (const key of ["cloudaicompanionProject", "projectId", "project_id"]) {
    const result = projectId(item[key], true);
    if (result) return result;
  }
  const project = projectId(item.project, true);
  if (project) return project;
  if (directId && item.id !== undefined) {
    const result = projectId(item.id);
    if (result) return result;
  }
  for (const key of ["response", "data", "result"]) {
    const result = projectId(item[key]);
    if (result) return result;
  }
}

function defaultTier(value: Record<string, unknown>) {
  if (Array.isArray(value.allowedTiers))
    for (const raw of value.allowedTiers) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const tier = raw as Record<string, unknown>;
      if (tier.isDefault !== true) continue;
      if (typeof tier.id === "string" && tier.id.trim())
        return tier.id.trim().slice(0, 256);
    }
  const current = value.currentTier;
  if (current && typeof current === "object" && !Array.isArray(current)) {
    const id = (current as Record<string, unknown>).id;
    if (typeof id === "string" && id.trim())
      return id.trim().slice(0, 256);
  }
  return "free-tier";
}

async function post(
  host: Host,
  url: string,
  accessToken: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
) {
  const response = await host.call<Response>(
    "http.transport@1",
    {
      url,
      method: "POST",
      publicOnly: true,
      headers: {
        authorization: "Bearer " + accessToken,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    },
    signal,
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw attemptError(response.status);
  }
  try {
    return await responseObject(response, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    throw attemptError();
  }
}

async function wait(signal: AbortSignal, milliseconds: number) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    timer.unref?.();
  });
  signal.throwIfAborted();
}

async function onboard(
  host: Host,
  endpoint: string,
  accessToken: string,
  tierId: string,
  signal: AbortSignal,
) {
  const body = {
    tier_id: tierId,
    metadata: {
      ide_type: "ANTIGRAVITY",
      ide_version: version,
      ide_name: "antigravity",
    },
  };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await post(
      host,
      endpoint + "/v1internal:onboardUser",
      accessToken,
      {
        accept: "*/*",
        "user-agent": onboardUserAgent,
        "x-goog-api-client": "gl-node/22.21.1",
      },
      body,
      signal,
    );
    const found = projectId(result);
    if (found) return found;
    if (attempt < 4) await wait(signal, 1500);
  }
}

function failure(statuses: Array<number | undefined>): never {
  if (statuses.includes(401))
    throw new HostError(
      "subscription_reauthorize",
      "订阅授权已失效，请重新授权",
      401,
    );
  if (statuses.includes(429))
    throw new HostError(
      "subscription_quota_limited",
      "Antigravity 服务请求过于频繁，请稍后重试",
      429,
    );
  if (statuses.includes(403))
    throw new HostError(
      "antigravity_project_forbidden",
      "当前授权无权访问 Antigravity 项目服务",
      403,
    );
  throw new HostError(
    "antigravity_project_discovery",
    "无法发现 Antigravity 项目，请稍后重试",
    502,
  );
}

export async function discoverAntigravityProject(
  host: Host,
  accessToken: string,
  signal: AbortSignal,
) {
  const token = accessToken.trim();
  if (!token)
    throw new HostError(
      "subscription_reauthorize",
      "订阅授权已失效，请重新授权",
      401,
    );
  const statuses: Array<number | undefined> = [];
  for (const endpoint of endpoints) {
    signal.throwIfAborted();
    try {
      const loaded = await post(
        host,
        endpoint + "/v1internal:loadCodeAssist",
        token,
        { "user-agent": antigravityUserAgent },
        { metadata: { ideType: "ANTIGRAVITY" } },
        signal,
      );
      const found = projectId(loaded);
      if (found) return found;
      const onboarded = await onboard(
        host,
        endpoint,
        token,
        defaultTier(loaded),
        signal,
      );
      if (onboarded) return onboarded;
    } catch (error) {
      signal.throwIfAborted();
      statuses.push((error as AttemptError).status);
    }
  }
  failure(statuses);
}

export async function antigravityAvailableModels(
  host: Host,
  accessToken: string,
  project: string,
  signal: AbortSignal,
) {
  const statuses: Array<number | undefined> = [];
  let successful = false;
  for (const endpoint of endpoints) {
    signal.throwIfAborted();
    try {
      const data = await post(
        host,
        endpoint + "/v1internal:fetchAvailableModels",
        accessToken,
        { "user-agent": antigravityUserAgent },
        { project },
        signal,
      );
      const response =
        data.response &&
        typeof data.response === "object" &&
        !Array.isArray(data.response)
          ? (data.response as Record<string, unknown>)
          : data;
      const models = response.models;
      if (models && typeof models === "object" && !Array.isArray(models)) {
        successful = true;
        return models as Record<string, unknown>;
      }
      successful = true;
      throw attemptError();
    } catch (error) {
      signal.throwIfAborted();
      statuses.push((error as AttemptError).status);
    }
  }
  if (successful) return {};
  failure(statuses);
}
