import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { HostError, requiredString, type Host } from "@pluhub/sdk";
import { transaction } from "../../lib/storage/sqlite.js";
import type { UserRecord } from "./users-store.js";

export const setupMigration =
  "CREATE TABLE setup_admin(id TEXT PRIMARY KEY,username TEXT NOT NULL,hash TEXT NOT NULL);";

export function installSetup(
  host: Host,
  db: DatabaseSync,
  usersStore: {
    lookup: (input: any) => UserRecord | undefined;
    manage: (input: any) => any;
  },
  hashPassword: (password: string) => Promise<string>,
  created: (userId: string) => void = () => {},
) {
  for (const pending of db
    .prepare("SELECT * FROM setup_admin")
    .all() as any[]) {
    const user = usersStore.lookup({ id: pending.id });
    const inserted = transaction(db, () => {
      let added = false;
      if (user?.role === "admin" && user.username === pending.username)
        added = !!db
          .prepare("INSERT OR IGNORE INTO passwords VALUES(?,?)")
          .run(pending.id, pending.hash).changes;
      db.prepare("DELETE FROM setup_admin WHERE id=?").run(pending.id);
      return added;
    });
    if (inserted) created(pending.id);
  }
  const initialized = async () =>
    Boolean(usersStore.manage({ action: "has-admin" }));
  let busy = false;
  host.provide("auth.setup@1", async (input) => {
    if (input?.action === "status") return { initialized: await initialized() };
    if (input?.action !== "create")
      throw new HostError("invalid_request", "未知初始化操作");
    if (busy)
      throw new HostError("setup_busy", "管理员正在创建，请稍后重试", 409);
    busy = true;
    try {
      if (await initialized())
        throw new HostError("setup_complete", "管理员已存在", 409);
      const username = requiredString(
        input.username,
        "username",
        64,
      ).toLowerCase();
      if (!/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(username))
        throw new HostError(
          "invalid_username",
          "用户名需为 3–64 位字母、数字、点、下划线或短横线",
        );
      const hash = await hashPassword(
        requiredString(input.password, "password", 1024),
      );
      const id = randomUUID();
      transaction(db, () => {
        usersStore.manage({ action: "create-initial-admin", id, username });
        db.prepare("INSERT INTO passwords VALUES(?,?)").run(id, hash);
      });
      created(id);
      return { created: true };
    } finally {
      busy = false;
    }
  });
  return { initialized };
}
