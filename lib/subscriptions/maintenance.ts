import type { Host } from "@pluhub/sdk";

/** Only OAuth and quota control endpoints are queried; never send inference probes. */
export function startSubscriptionMaintenance(options: {
  host: Host;
  signal: AbortSignal;
  list: () => { id: string; cooling: boolean }[];
  refresh: (id: string) => Promise<unknown>;
  overview: (id: string) => Promise<unknown>;
}) {
  const next = new Map<string, { at: number; failures: number }>();
  let timer: ReturnType<typeof setTimeout>;
  let running: Promise<void> | undefined;
  async function tick() {
    const rows = options.list();
    const ids = new Set(rows.map((r) => r.id));
    for (const id of next.keys()) if (!ids.has(id)) next.delete(id);
    let cursor = 0;
    await Promise.all(
      [0, 1].map(async () => {
        while (cursor < rows.length && !options.signal.aborted) {
          const row = rows[cursor++]!;
          const state = next.get(row.id);
          if (state?.failures && state.at > Date.now()) continue;
          if (state && row.cooling)
            state.at = Math.min(state.at, Date.now() + 60000);
          try {
            await options.refresh(row.id);
            if (state && state.at > Date.now()) continue;
            await options.overview(row.id);
            next.set(row.id, {
              at: Date.now() + (row.cooling ? 60000 : 300000),
              failures: 0,
            });
            if (state?.failures)
              options.host.log("info", `订阅账号检查已恢复：${row.id}`);
          } catch (error) {
            if (options.signal.aborted) return;
            const failures = (state?.failures ?? 0) + 1;
            next.set(row.id, {
              at:
                Date.now() +
                Math.min(900000, 30000 * 2 ** Math.min(failures - 1, 5)),
              failures,
            });
            if (!state?.failures)
              options.host.log(
                "warn",
                `订阅账号后台检查失败：${row.id} (${typeof (error as any)?.code === "string" ? (error as any).code : "subscription_check_failed"})`,
              );
          }
        }
      }),
    );
  }
  function schedule(delay: number) {
    timer = setTimeout(() => {
      running = tick()
        .catch(() => {
          if (!options.signal.aborted)
            options.host.log("error", "订阅账号后台维护失败");
        })
        .finally(() => {
          running = undefined;
          if (!options.signal.aborted) schedule(30000);
        });
    }, delay);
    timer.unref?.();
  }
  schedule(10000);
  return async () => {
    clearTimeout(timer);
    await running;
    next.clear();
  };
}
