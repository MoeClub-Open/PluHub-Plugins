import { DatabaseSync } from "node:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  cp,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
const kinds = ["codex", "claude-subscription", "antigravity"];
const exists = async (path) =>
  !!(await stat(path).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  }));
const aad = (row) =>
  Buffer.from(
    JSON.stringify(
      row.owner_id
        ? [row.id, row.provider, row.owner_id]
        : [row.id, row.provider],
    ),
  );
function decrypt(row, key) {
  const data = Buffer.from(row.cipher, "base64"),
    cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  cipher.setAAD(aad(row));
  cipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]);
}
function encrypt(row, value, key) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(row));
  return Buffer.concat([
    iv,
    cipher.update(value),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}
/** Offline maintenance tool owned by the official subscription plugins. Never imports Host internals. */
export async function migrateSubscriptions(file, pluginsRoot) {
  file = resolve(file);
  const config = JSON.parse(await readFile(file, "utf8")),
    base = dirname(file),
    before = structuredClone(config);
  const manifestAt = async (entry) =>
    JSON.parse(
      await readFile(join(resolve(base, entry.path), "manifest.json"), "utf8"),
    );
  const entries = await Promise.all(
    config.plugins.map(async (settings) => ({
      settings,
      manifest: await manifestAt(settings),
    })),
  );
  const legacy = entries.find(
    (entry) => entry.manifest.id === "official.subscription-accounts",
  );
  if (!legacy) return { migrated: false, counts: {} };
  // Do not run against the live CLI. Container callers must stop the gateway before invoking this tool.
  if (await exists(file + ".pid")) {
    const pid = Number(await readFile(file + ".pid", "utf8"));
    let running = false;
    try {
      process.kill(pid, 0);
      running = true;
    } catch (error) {
      if (error.code !== "ESRCH") running = true;
    }
    if (running) throw new Error("Stop the host before subscription migration");
  }
  const data = resolve(base, config.dataDir),
    source = join(data, "official.subscription-accounts");
  const backup = resolve(
    base,
    ".pluhub/migrations",
    "subscriptions-" + randomUUID(),
  );
  await mkdir(backup, { recursive: true, mode: 0o700 });
  await writeFile(
    join(backup, "before.json"),
    JSON.stringify(before, null, 2),
    { mode: 0o600 },
  );
  const sourceDb = join(source, "accounts.sqlite"),
    hasDb = await exists(sourceDb);
  let oldKey,
    rows = [];
  if (hasDb) {
    const ref = legacy.settings.config?.masterKeyRef;
    oldKey = ref
      ? Buffer.from(process.env[ref.replace(/^env:/, "")] ?? "", "base64")
      : await readFile(join(source, "vault.key"));
    if (oldKey.length !== 32)
      throw new Error("Legacy vault key is unavailable");
    const db = new DatabaseSync(sourceDb);
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const version = Number(
        db.prepare("PRAGMA user_version").get().user_version,
      );
      if (version !== 3)
        throw new Error(
          "Migrate the legacy account schema to version 3 before splitting",
        );
      rows = db.prepare("SELECT * FROM accounts").all();
      if (rows.some((row) => !kinds.includes(row.provider)))
        throw new Error("Unknown legacy subscription provider");
      // Authenticate every ciphertext before modifying configuration or target data.
      for (const row of rows) {
        const plain = decrypt(row, oldKey);
        try {
          JSON.parse(plain.toString());
        } finally {
          plain.fill(0);
        }
      }
    } finally {
      db.close();
    }
    await cp(source, join(backup, "legacy"), { recursive: true });
  }
  const stage = await (
      await import("node:fs/promises")
    ).mkdtemp(join(data, ".subscription-migration-")),
    published = [];
  try {
    const counts = {};
    for (const kind of kinds) {
      const id = "official.upstream-" + kind,
        existing = entries.find((entry) => entry.manifest.id === id);
      const path = existing
        ? resolve(base, existing.settings.path)
        : resolve(pluginsRoot, "upstream-" + kind);
      const manifest = JSON.parse(
        await readFile(join(path, "manifest.json"), "utf8"),
      );
      if (!manifest.provides.includes("ai.subscription." + kind + "@1"))
        throw new Error("Install the split provider packages before migration");
      const original = existing?.settings.config ?? {},
        oauth = legacy.settings.config?.oauth?.[kind],
        settings = { ...original };
      if (oauth)
        settings.oauth = {
          ...settings.oauth,
          [kind]: { ...oauth, ...settings.oauth?.[kind] },
        };
      settings.secretRefs = [
        ...new Set([
          ...(original.secretRefs ?? []),
          ...(settings.oauth?.[kind]?.clientSecretRef
            ? [settings.oauth[kind].clientSecretRef]
            : []),
        ]),
      ];
      const target = join(data, id);
      await mkdir(target, { recursive: true, mode: 0o700 });
      if (
        (await exists(join(target, "accounts.sqlite"))) ||
        (await exists(join(target, "vault.key")))
      )
        throw new Error(
          "Target subscription storage already exists; no data overwritten",
        );
      counts[kind] = rows.filter((row) => row.provider === kind).length;
      if (hasDb) {
        const key = settings.masterKeyRef
          ? Buffer.from(
              process.env[settings.masterKeyRef.replace(/^env:/, "")] ?? "",
              "base64",
            )
          : randomBytes(32);
        if (key.length !== 32)
          throw new Error("Target vault key is unavailable");
        const folder = join(stage, id);
        await mkdir(folder, { mode: 0o700 });
        await cp(sourceDb, join(folder, "accounts.sqlite"));
        if (!settings.masterKeyRef)
          await writeFile(join(folder, "vault.key"), key, { mode: 0o600 });
        const db = new DatabaseSync(join(folder, "accounts.sqlite"));
        try {
          db.exec("BEGIN IMMEDIATE");
          db.prepare("DELETE FROM accounts WHERE provider<>?").run(kind);
          for (const row of rows.filter((row) => row.provider === kind)) {
            const value = decrypt(row, oldKey);
            try {
              db.prepare("UPDATE accounts SET cipher=? WHERE id=?").run(
                encrypt(row, value, key),
                row.id,
              );
            } finally {
              value.fill(0);
            }
          }
          db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
        } finally {
          db.close();
          key.fill(0);
        }
        for (const name of [
          "accounts.sqlite",
          ...(settings.masterKeyRef ? [] : ["vault.key"]),
        ]) {
          const dest = join(target, name);
          await cp(join(folder, name), dest, {
            errorOnExist: true,
            force: false,
          });
          published.push(dest);
        }
      }
      const next = {
        ...(existing?.settings ?? {}),
        path,
        version: manifest.version,
        config: settings,
        grants: [
          ...new Set([
            ...(existing?.settings.grants ?? []),
            ...manifest.permissions,
          ]),
        ],
      };
      // A new package may be staged under a different path by the maintenance release.
      if (existing)
        config.plugins[config.plugins.indexOf(existing.settings)] = next;
      else config.plugins.push(next);
    }
    config.plugins = config.plugins.filter(
      (entry) => entry !== legacy.settings,
    );
    if (config.bindings?.["ai.subscription-accounts@1"])
      delete config.bindings["ai.subscription-accounts@1"];
    const temp = file + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temp, JSON.stringify(config, null, 2) + "\n", {
        mode: 0o600,
      });
      await rename(temp, file);
    } finally {
      await rm(temp, { force: true });
    }
    return { migrated: true, counts, backup };
  } catch (error) {
    for (const path of published) await rm(path, { force: true });
    throw error;
  } finally {
    oldKey?.fill(0);
    await rm(stage, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  migrateSubscriptions(
    process.argv[2] ?? "pluhub.json",
    process.argv[3] ?? "plugins",
  )
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error(
        "Subscription migration failed; preserve the backup and inspect local configuration. No credentials were printed.",
      );
      process.exitCode = 1;
    });
}
