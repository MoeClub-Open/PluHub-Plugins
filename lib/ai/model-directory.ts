import type { ProviderConnection } from "@pluhub/contracts/ai";
import {
  HostError,
  requiredString,
  type Host,
} from "@pluhub/sdk";
import { responseObject } from "./json-response.js";

export type DirectoryModel = {
  id: string;
  name?: string;
  contextLength?: number;
  maxOutputTokens?: number;
};

const apiProtocols = new Set([
  "openai-chat",
  "openai-responses",
  "anthropic",
  "gemini",
]);

function positiveInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : undefined;
}

export function directoryModels(
  protocol: string,
  raw: unknown,
): DirectoryModel[] {
  if (!raw || typeof raw !== "object")
    throw new HostError("upstream_error", "上游返回了无效的模型目录", 502);
  const value = raw as Record<string, unknown>;
  const entries = protocol === "gemini" ? value.models : value.data;
  if (!Array.isArray(entries))
    throw new HostError("upstream_error", "上游返回了无效的模型目录", 502);
  const models = new Map<string, DirectoryModel>();
  for (const rawModel of entries) {
    if (!rawModel || typeof rawModel !== "object") continue;
    const item = rawModel as Record<string, unknown>;
    const id =
      protocol === "gemini" && typeof item.name === "string"
        ? item.name.replace(/^models\//, "")
        : item.id;
    if (
      typeof id !== "string" ||
      !id ||
      id.length > 256 ||
      id.trim() !== id
    )
      continue;
    const name =
      typeof item.display_name === "string" && item.display_name.trim()
        ? item.display_name.trim().slice(0, 256)
        : typeof item.displayName === "string" && item.displayName.trim()
          ? item.displayName.trim().slice(0, 256)
          : id;
    const model: DirectoryModel = {
      id,
      name,
      contextLength: positiveInteger(
        item.context_length ??
          item.context_window ??
          item.inputTokenLimit ??
          item.contextWindow,
      ),
      maxOutputTokens: positiveInteger(
        item.max_completion_tokens ??
          item.max_output_tokens ??
          item.outputTokenLimit ??
          item.maxOutputTokens,
      ),
    };
    const previous = models.get(id);
    models.set(id, {
      ...previous,
      ...model,
      contextLength:
        Math.max(previous?.contextLength ?? 0, model.contextLength ?? 0) ||
        undefined,
      maxOutputTokens:
        Math.max(
          previous?.maxOutputTokens ?? 0,
          model.maxOutputTokens ?? 0,
        ) || undefined,
    });
  }
  return [...models.values()].slice(0, 512);
}

function directoryUrl(protocol: string, baseUrl: string) {
  let url: URL;
  try {
    url = new URL(requiredString(baseUrl, "upstream URL", 2048));
  } catch {
    throw new HostError("invalid_upstream", "无效的上游地址");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new HostError("invalid_upstream", "无效的上游地址");
  const suffix = protocol === "gemini" ? "/v1beta/models" : "/v1/models";
  const prefix = url.pathname
    .replace(/\/$/, "")
    .replace(protocol === "gemini" ? /\/v1beta$/ : /\/v1$/, "");
  url.pathname = prefix + suffix;
  return url;
}

async function upstreamSecret(
  host: Host,
  upstream: ProviderConnection,
  signal: AbortSignal,
) {
  if (upstream.credentialId)
    return (
      await host.call<{ secret: string }>(
        "credentials.resolve@1",
        {
          id: upstream.credentialId,
          userId: upstream.credentialOwner,
        },
        signal,
      )
    ).secret;
  return host.secret(
    requiredString(upstream.keyRef, "upstream keyRef"),
  );
}

export async function discoverApiModels(
  host: Host,
  upstream: ProviderConnection,
  parentSignal: AbortSignal,
) {
  const protocol = upstream.protocol;
  if (!apiProtocols.has(protocol))
    throw new HostError(
      "unsupported_operation",
      "该上游不支持模型目录查询",
    );
  const signal = AbortSignal.any([
    parentSignal,
    AbortSignal.timeout(15_000),
  ]);
  const secret = await upstreamSecret(host, upstream, signal);
  const url = directoryUrl(protocol, upstream.baseUrl ?? "");
  const headers: Record<string, string> =
    protocol === "gemini"
      ? { "x-goog-api-key": secret }
      : protocol === "anthropic"
        ? { "x-api-key": secret, "anthropic-version": "2023-06-01" }
        : { authorization: "Bearer " + secret };
  const response = await host.call<Response>(
    "http.transport@1",
    {
      url: url.href,
      method: "GET",
      headers,
      publicOnly: upstream.publicOnly,
    },
    signal,
  );
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new HostError("upstream_error", "上游模型目录不可用", 502);
  }
  return directoryModels(
    protocol,
    await responseObject(response, signal, 2_000_000),
  );
}
