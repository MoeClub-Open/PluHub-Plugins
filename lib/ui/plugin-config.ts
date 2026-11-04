import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";

export async function readPluginConfig<T = Record<string, any>>(
  host: UIHost,
  pluginId: string,
  signal?: AbortSignal,
): Promise<{ config: T; etag: string }> {
  return host.pluginConfig<T>(pluginId, signal);
}

export async function updatePluginConfig<T = Record<string, any>>(
  host: UIHost,
  pluginId: string,
  mutate: (current: T) => T,
  signal?: AbortSignal,
): Promise<T> {
  const { config: current, etag } = await readPluginConfig<T>(
    host,
    pluginId,
    signal,
  );
  const next = mutate(structuredClone(current ?? ({} as T)));
  const saved = await host.savePluginConfig<T>(pluginId, next, etag, signal);
  return saved.config;
}

export function usePluginConfig<T = Record<string, any>>(
  host: UIHost,
  pluginId: string,
) {
  const [data, setData] = React.useState<T>();
  const [error, setError] = React.useState("");
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    const controller = new AbortController();
    setError("");
    void readPluginConfig<T>(host, pluginId, controller.signal)
      .then(({ config }) => {
        if (!controller.signal.aborted) setData(config);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError((failure as Error).message);
      });
    return () => controller.abort();
  }, [host, pluginId, tick]);
  const reload = React.useCallback(() => setTick((n) => n + 1), []);
  const save = React.useCallback(
    async (mutate: (current: T) => T) => {
      const saved = await updatePluginConfig<T>(host, pluginId, mutate);
      setData(saved);
      return saved;
    },
    [host, pluginId],
  );
  return { data, error, reload, save };
}
