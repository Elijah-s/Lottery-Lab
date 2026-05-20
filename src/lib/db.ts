/**
 * SQLite singleton access for the front-end.
 *
 * We use a module-level promise so concurrent callers share the same
 * `Database.load(...)` invocation. `@tauri-apps/plugin-sql` caches the
 * connection server-side too, but explicit singletonization avoids the
 * "is the plugin initialized yet?" race during app startup.
 */

import Database from "@tauri-apps/plugin-sql";

const DB_URL = "sqlite:lottery_lab.db";

let dbSingleton: Promise<Database> | null = null;

export function getDb(): Promise<Database> {
  if (!dbSingleton) {
    dbSingleton = Database.load(DB_URL);
  }
  return dbSingleton;
}

/** For tests / lifecycle resets: forget the cached instance. */
export function resetDb(): void {
  dbSingleton = null;
}
