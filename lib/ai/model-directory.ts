import type { ProviderConnection } from "@pluhub/contracts/ai";
import { HostError, requiredString, type Host } from "@pluhub/sdk";
import { responseObject } from "./json-response.js";
import {
  connectionInterfaces,
  interfaceHeaders,
  interfaceMatches,
  upstreamUrl,
} from "./upstream-interfaces.js";

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
    if (typeof id !== "string" || !id || id.length > 256 || id.trim() !== id)
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
        Math.max(previous?.maxOutputTokens ?? 0, model.maxOutputTokens ?? 0) ||
        undefined,
    });
  }
  return [...models.values()].slice(0, 512);
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
  return host.secret(requiredString(upstream.keyRef, "upstream keyRef"));
}

export async function discoverApiModels(
  host: Host,
  upstream: ProviderConnection,
  parentSignal: AbortSignal,
  suppliedSecret?: string,
) {
  const protocol = upstream.protocol;
  if (!apiProtocols.has(protocol))
    throw new HostError("unsupported_operation", "该上游不支持模型目录查询");
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(15_000)]);
  const secret =
    suppliedSecret ?? (await upstreamSecret(host, upstream, signal));
  const url = upstreamUrl(
    upstream.baseUrl ?? "",
    upstream.http?.modelsPath ??
      (protocol === "gemini" ? "/v1beta/models" : "/v1/models"),
  );
  const headers = interfaceHeaders(protocol, upstream.http, secret, url);
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

export async function discoverConnectionModels(
  host: Host,
  connection: ProviderConnection,
  signal: AbortSignal,
  secret?: string,
) {
  const interfaces = connectionInterfaces(connection);
  // Chat and Responses usually share /models. Avoid duplicate discovery calls.
  const tasks = new Map<string, Promise<DirectoryModel[]>>();
  const results = await Promise.allSettled(
    interfaces.map(async (upstream, index) => {
      const key = JSON.stringify([
        upstream.protocol === "openai-responses"
          ? "openai-chat"
          : upstream.protocol,
        upstream.baseUrl,
        upstream.http?.modelsPath,
        upstream.http?.auth,
        upstream.http?.headers,
      ]);
      let task = tasks.get(key);
      if (!task) {
        task = host.call<DirectoryModel[]>(
          "ai.upstream-models." + upstream.protocol + "@1",
          { upstream, secret },
          signal,
        );
        tasks.set(key, task);
      }
      const models = await task;
      const route = connection.interfaces?.[index];
      return models
        .filter((model) => !route || interfaceMatches(route, model.id))
        .map((model) => ({ ...model, protocols: [upstream.protocol] }));
    }),
  );
  const models = new Map<string, DirectoryModel & { protocols: string[] }>();
  const errors: { protocol: string; message: string }[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      errors.push({
        protocol: interfaces[index]!.protocol,
        message:
          result.reason instanceof Error
            ? result.reason.message
            : "模型目录查询失败",
      });
      continue;
    }
    for (const model of result.value) {
      const previous = models.get(model.id);
      models.set(model.id, {
        ...previous,
        ...model,
        protocols: [
          ...new Set([...(previous?.protocols ?? []), ...model.protocols]),
        ],
      });
    }
  }
  return { models: [...models.values()], errors };
}
