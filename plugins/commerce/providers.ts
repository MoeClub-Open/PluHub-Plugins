import { HostError, type Host } from "@pluhub/sdk";
import type { PaymentProviderStatus } from "@pluhub/contracts/commerce";

export function paymentProviders(host: Host) {
  async function list(signal?: AbortSignal) {
    const results = await Promise.allSettled(
      host.providers("payments.provider@1").map(async (plugin) => ({
        ...(await host.call<PaymentProviderStatus>(
          "payments.provider@1",
          { action: "status" },
          signal,
          plugin.id,
        )),
        pluginId: plugin.id,
      })),
    );
    signal?.throwIfAborted();
    const providers = results.flatMap((result) => {
      if (result.status === "fulfilled") return [result.value];
      host.log("warn", "A payment provider is unavailable");
      return [];
    });
    const ids = new Set<string>();
    for (const provider of providers) {
      if (!provider.id || ids.has(provider.id))
        throw new HostError(
          "invalid_provider",
          "Payment provider IDs must be unique",
          503,
        );
      ids.add(provider.id);
    }
    return providers;
  }
  async function get(id: string, signal?: AbortSignal) {
    const provider = (await list(signal)).find(
      (provider) => provider.id === id,
    );
    if (!provider)
      throw new HostError(
        "payment_unavailable",
        "This payment provider is unavailable",
        409,
      );
    return provider;
  }
  async function call<T = unknown>(
    id: string,
    input: { action: string; [key: string]: unknown },
    signal?: AbortSignal,
  ): Promise<T> {
    const provider = await get(id, signal);
    return host.call<T>(
      "payments.provider@1",
      input,
      signal,
      provider.pluginId,
    );
  }
  return { list, get, call };
}
