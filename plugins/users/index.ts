import { openDatabase } from "../../lib/storage/sqlite.js";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { requireAdmin, adminTarget } from "../../lib/admin/access.js";
import {
  definePlugin,
  HostError,
  json,
  readObject,
  requiredString,
} from "@pluhub/sdk";
export default definePlugin({
  setup(host) {
    const db = openDatabase(join(host.dataDir, "users.sqlite"), [
      "CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,role TEXT NOT NULL,enabled INTEGER NOT NULL,created_at TEXT NOT NULL);",
      "ALTER TABLE users ADD COLUMN language TEXT CHECK(language IN ('zh-CN','en-US'));",
      "ALTER TABLE users ADD COLUMN account_type TEXT NOT NULL DEFAULT 'personal' CHECK(account_type IN ('personal','enterprise')); ALTER TABLE users ADD COLUMN parent_id TEXT REFERENCES users(id); CREATE INDEX users_parent ON users(parent_id);",
    ]);
    host.cleanup(() => db.close());
    const user = (row: any) =>
      row
        ? {
            id: row.id,
            username: row.username,
            role: row.role,
            enabled: !!row.enabled,
            createdAt: row.created_at,
            language: row.language ?? null,
            accountType: row.account_type,
            parentId: row.parent_id ?? null,
          }
        : undefined;
    const lookup = (input: any) =>
      user(
        input.id
          ? db.prepare("SELECT * FROM users WHERE id=?").get(input.id)
          : db
              .prepare("SELECT * FROM users WHERE username=?")
              .get(String(input.username).toLowerCase()),
      );
    function membership(input: any, existing?: any) {
      const accountType =
        input.accountType ?? existing?.accountType ?? "personal";
      const parentId =
        input.parentId === undefined
          ? (existing?.parentId ?? null)
          : input.parentId;
      if (
        !["personal", "enterprise"].includes(accountType) ||
        (parentId !== null &&
          (typeof parentId !== "string" || parentId.length > 128))
      )
        throw new HostError("invalid_request", "Invalid account membership");
      if (parentId) {
        const parent = lookup({ id: parentId });
        if (
          !parent ||
          (!parent.enabled && parentId !== existing?.parentId) ||
          parent.accountType !== "enterprise" ||
          parent.parentId ||
          parent.id === existing?.id ||
          accountType === "enterprise" ||
          (input.role ?? existing?.role) === "admin"
        )
          throw new HostError("invalid_request", "Invalid enterprise parent");
      }
      if (
        existing &&
        (accountType !== "enterprise" || parentId) &&
        db
          .prepare("SELECT 1 FROM users WHERE parent_id=? LIMIT 1")
          .get(existing.id)
      )
        throw new HostError(
          "account_has_children",
          "Reassign subaccounts before changing the enterprise account",
          409,
        );
      return { accountType, parentId };
    }
    const manage = (input: any) => {
      if (input.action === "has-admin")
        return !!db
          .prepare("SELECT 1 FROM users WHERE role='admin' LIMIT 1")
          .get();
      if (input.action === "list")
        return db
          .prepare("SELECT * FROM users ORDER BY created_at")
          .all()
          .map(user);
      if (
        input.action === "create" ||
        input.action === "create-initial-admin"
      ) {
        const initial = input.action === "create-initial-admin";
        if (
          initial &&
          db.prepare("SELECT 1 FROM users WHERE role='admin' LIMIT 1").get()
        )
          throw new HostError("setup_complete", "管理员已存在", 409);
        const username = requiredString(
          input.username,
          "username",
          64,
        ).toLowerCase();
        if (!/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(username))
          throw new HostError(
            "invalid_username",
            "Username must contain 3–64 letters, digits, dots, underscores or hyphens",
          );
        const role = initial ? "admin" : (input.role ?? "user");
        if (!["admin", "user"].includes(role))
          throw new HostError("invalid_role", "Invalid role");
        const id = initial ? requiredString(input.id, "id", 64) : randomUUID();
        const member = membership({ ...input, role });
        try {
          db.prepare(
            "INSERT INTO users(id,username,role,enabled,created_at,account_type,parent_id) VALUES(?,?,?,?,?,?,?)",
          ).run(
            id,
            username,
            role,
            1,
            new Date().toISOString(),
            member.accountType,
            member.parentId,
          );
        } catch {
          throw new HostError("user_exists", "Username already exists", 409);
        }
        return lookup({ id });
      }
      if (input.action === "preferences") {
        const id = requiredString(input.id, "id");
        if (!lookup({ id }))
          throw new HostError("not_found", "User not found", 404);
        if (![null, "zh-CN", "en-US"].includes(input.language))
          throw new HostError("invalid_language", "Unsupported language");
        db.prepare("UPDATE users SET language=? WHERE id=?").run(
          input.language,
          id,
        );
        return lookup({ id });
      }
      if (input.action === "update") {
        const existing = lookup({ id: requiredString(input.id, "id") });
        if (!existing) throw new HostError("not_found", "User not found", 404);
        const role = input.role ?? existing.role;
        const enabled = input.enabled ?? existing.enabled;
        if (!["admin", "user"].includes(role) || typeof enabled !== "boolean")
          throw new HostError("invalid_request", "Invalid user update");
        if (
          existing.role === "admin" &&
          existing.enabled &&
          (role !== "admin" || !enabled) &&
          Number(
            (
              db
                .prepare(
                  "SELECT count(*) AS n FROM users WHERE role='admin' AND enabled=1",
                )
                .get() as any
            ).n,
          ) <= 1
        )
          throw new HostError(
            "last_admin",
            "Cannot disable the last administrator",
            409,
          );
        const member = membership({ ...input, role }, existing);
        db.prepare(
          "UPDATE users SET role=?,enabled=?,account_type=?,parent_id=? WHERE id=?",
        ).run(
          role,
          enabled ? 1 : 0,
          member.accountType,
          member.parentId,
          existing.id,
        );
        return lookup({ id: existing.id });
      }
      throw new HostError("invalid_action", "Unknown user action");
    };
    host.provide("users.lookup@1", lookup);
    host.provide("users.manage@1", manage);
    host.provide("users.directory@1", () =>
      db.prepare("SELECT id,username AS name FROM users WHERE enabled=1").all(),
    );
    host.provide("users.log-scope@1", (input: any) => {
      const actor = lookup({ id: requiredString(input.id, "id") });
      if (!actor?.enabled)
        throw new HostError("forbidden", "User unavailable", 403);
      const scope =
        input.all === true && actor.role === "admin"
          ? "all"
          : input.children === true &&
              actor.accountType === "enterprise" &&
              !actor.parentId
            ? "enterprise"
            : "self";
      const rows =
        scope === "all"
          ? db
              .prepare(
                "SELECT id,username AS name FROM users ORDER BY username",
              )
              .all()
          : scope === "enterprise"
            ? db
                .prepare(
                  "SELECT id,username AS name FROM users WHERE id=? OR parent_id=? ORDER BY username",
                )
                .all(actor.id, actor.id)
            : [{ id: actor.id, name: actor.username }];
      return { scope, users: rows };
    });
    host.api({
      method: "GET",
      path: "/users",
      access: "users.manage",
      handle: () => json(manage({ action: "list" })),
    });
    host.api({
      method: "POST",
      path: "/users",
      access: "users.manage",
      handle: async (request, ctx) => {
        await requireAdmin(host, request, ctx);
        const result = manage({
          ...(await readObject(request)),
          action: "create",
        }) as any;
        adminTarget(ctx, result!.id);
        return json(result, 201);
      },
    });
    host.api({
      method: "PATCH",
      path: "/users",
      access: "users.manage",
      handle: async (request, ctx) => {
        await requireAdmin(host, request, ctx);
        const body = await readObject(request);
        adminTarget(
          ctx,
          requiredString(body.id, "id"),
          undefined,
          typeof body.reason === "string" ? body.reason : undefined,
        );
        return json(manage({ ...body, action: "update" }));
      },
    });
  },
});
