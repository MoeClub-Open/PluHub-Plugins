import { keyReferences } from "../../lib/ai/upstream-key.js";
import {
  HostError,
  json,
  readObject,
  type Host,
  type HostConfig,
} from "@pluhub/sdk";
import type { Upstream } from "@pluhub/contracts/ai";
import { requireAdmin } from "../../lib/admin/access.js";
import { channelConnections } from "../../lib/ai/channel-config.js";
import { connectionInterfaces } from "../../lib/ai/upstream-interfaces.js";

export function installConfiguration(host: Host) {
  async function dispatch(request: Request, path: string, init?: RequestInit) {
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    headers.delete("content-type");
    for (const [key, value] of new Headers(init?.headers))
      headers.set(key, value);
    const response = await host.dispatch(
      new Request(new URL(path, request.url), {
        ...init,
        headers,
        signal: request.signal,
      }),
    );
    const value = await response.json();
    if (!response.ok)
      throw new HostError(
        value.error?.code ?? "configuration_failed",
        value.error?.message ?? "配置更新失败",
        response.status,
      );
    return { value, revision: response.headers.get("etag") };
  }
  for (const method of ["GET", "PUT"])
    host.api({
      method,
      path: "/configuration",
      access: "host.manage",
      handle: async (request, ctx) => {
        await requireAdmin(host, request, ctx);
        const { value, revision } = await dispatch(request, "/api/host/config");
        const config = value as HostConfig;
        const { value: installed } = await dispatch(
          request,
          "/api/host/plugins",
        );
        const identities = new Map<
          string,
          { id: string; manifest: { provides: string[] } }
        >(installed.map((plugin: any) => [plugin.path, plugin]));
        const router = config.plugins.find(
          (plugin) => identities.get(plugin.path)?.id === host.id,
        );
        if (!router)
          throw new HostError("not_found", "渠道插件配置不存在", 404);
        if (method === "GET") {
          const settings = (id: string) =>
            config.plugins.find(
              (plugin) => identities.get(plugin.path)?.id === id,
            )?.config;
          return json({
            config: router.config,
            revision,
            references: {
              routingProfiles: Object.keys(
                settings("official.auto-router")?.profiles ?? {},
              ),
              tokenizers: Object.keys(
                settings("official.token-speed")?.tokenizers ?? {},
              ),
            },
          });
        }
        const body = await readObject(request);
        if (!body.revision || body.revision !== revision)
          throw new HostError(
            "config_conflict",
            "配置已更新，请刷新后重试",
            409,
          );
        if (
          !body.config ||
          typeof body.config !== "object" ||
          Array.isArray(body.config)
        )
          throw new HostError(
            "invalid_config",
            "Invalid channel configuration",
          );
        for (const connection of Object.values(
          body.config.upstreams ?? {},
        ).flatMap((value) => channelConnections(value as Upstream)))
          if (connection.keyRef !== undefined)
            connection.keyRef = keyReferences(connection.keyRef);
        const references = (settings: any, capability: string) =>
          new Set<string>(
            Object.values(
              (settings?.upstreams ?? {}) as Record<string, Upstream>,
            )
              .flatMap(channelConnections)
              .flatMap(connectionInterfaces)
              .filter(
                (connection) =>
                  capability === `ai.upstream.${connection.protocol}@1` ||
                  capability === `ai.media.${connection.protocol}@1`,
              )
              .flatMap((connection) => keyReferences(connection.keyRef)),
          );
        for (const plugin of config.plugins) {
          const capabilities =
            identities.get(plugin.path)?.manifest.provides ?? [];
          const before = new Set(
            capabilities.flatMap((name) => [
              ...references(router.config, name),
            ]),
          );
          const after = new Set(
            capabilities.flatMap((name) => [...references(body.config, name)]),
          );
          if (!before.size && !after.size) continue;
          const existing = (plugin.config?.secretRefs ?? []) as string[];
          plugin.config = {
            ...plugin.config,
            secretRefs: [
              ...new Set([
                ...existing.filter((ref) => !before.has(ref) || after.has(ref)),
                ...after,
              ]),
            ],
          };
        }
        router.config = body.config;
        const result = await dispatch(request, "/api/host/config", {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "if-match": body.revision,
          },
          body: JSON.stringify(config),
        });
        return json(result.value);
      },
    });
}
