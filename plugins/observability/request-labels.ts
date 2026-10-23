import type { Host } from "@pluhub/sdk";

export async function attachRequestLabels(
  host: Host,
  rows: Record<string, any>[],
  users: { id: string; name: string }[],
  signal: AbortSignal,
) {
  const identity = (userId: string, keyId: string) =>
    JSON.stringify([userId, keyId]);
  const names = new Map<string, string>();
  const missing = new Map<string, { id: string; userId: string }>();
  for (const row of rows)
    if (!row.key_name && row.key_id && row.user_id)
      missing.set(identity(row.user_id, row.key_id), {
        id: row.key_id,
        userId: row.user_id,
      });
  if (missing.size && host.hasCapability("auth.key-names@1")) {
    try {
      const keys = [...missing.values()];
      for (let start = 0; start < keys.length; start += 500)
        for (const key of await host.call<
          { id: string; userId: string; name: string }[]
        >("auth.key-names@1", { keys: keys.slice(start, start + 500) }, signal))
          names.set(identity(key.userId, key.id), key.name);
    } catch {
      signal.throwIfAborted();
      host.log("warn", "Request key names are temporarily unavailable");
    }
  }
  const userNames = new Map(users.map((user) => [user.id, user.name]));
  return rows.map((row) => {
    let effort: string | null = null;
    try {
      const routing = row.routing ? JSON.parse(row.routing) : null;
      if (typeof routing?.effort === "string") effort = routing.effort;
    } catch {}
    return {
      ...row,
      user_name: row.user_name ?? userNames.get(row.user_id) ?? null,
      key_name:
        row.key_name ?? names.get(identity(row.user_id, row.key_id)) ?? null,
      effort,
    };
  });
}
