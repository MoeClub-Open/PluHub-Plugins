import { HostError } from "@pluhub/sdk";

export function upstreamRejection(status: number) {
  return Object.assign(
    new HostError(
      "upstream_rejected",
      "上游拒绝了请求",
      status === 429 ? 429 : 502,
    ),
    {
      upstreamStatus: status,
      generationRejected: [400, 401, 403, 404, 422, 429, 503].includes(status),
      retryable: [401, 403, 404, 429, 503].includes(status),
    },
  );
}
export function generationRejected(error: unknown) {
  const value = error as { generationRejected?: boolean; code?: string };
  return (
    value?.generationRejected === true ||
    [
      "subscription_unavailable",
      "subscription_disabled",
      "subscription_reauthorize",
      "subscription_quota_exhausted",
      "subscription_rate_limited",
      "subscription_forbidden",
      "credentials_required",
      "credential_unavailable",
    ].includes(value?.code ?? "")
  );
}
export function prepareBeforeGeneration<T>(prepare: () => T): T {
  const rejected = (error: unknown): never => {
    if (error instanceof Error)
      Object.assign(error, { generationRejected: true });
    throw error;
  };
  try {
    const value = prepare();
    return value instanceof Promise ? (value.catch(rejected) as T) : value;
  } catch (error) {
    return rejected(error);
  }
}
