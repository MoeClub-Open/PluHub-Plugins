import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = work();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export function openDatabase(file: string, migrations: string[]): DatabaseSync {
  const db = new DatabaseSync(file);
  try {
    chmodSync(file, 0o600);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    for (const suffix of ["-wal", "-shm"]) {
      try {
        chmodSync(file + suffix, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const version = Number(
      (db.prepare("PRAGMA user_version").get() as any).user_version,
    );
    if (version > migrations.length)
      throw new Error("Database schema is newer than this plugin");
    for (let i = version; i < migrations.length; i++) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(migrations[i]!);
        db.exec("PRAGMA user_version=" + (i + 1));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
