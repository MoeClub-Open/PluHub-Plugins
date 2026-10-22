import type { DatabaseSync } from "node:sqlite";
/** Call inside the owner's transaction, after all authentication checks succeed. */
export function storePassword(db: DatabaseSync, userId: string, hash: string) {
  db.prepare(
    "INSERT INTO passwords VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET hash=excluded.hash",
  ).run(userId, hash);
  db.prepare("DELETE FROM sessions WHERE user_id=?").run(userId);
  db.prepare("DELETE FROM auth_challenges WHERE user_id=?").run(userId);
}
