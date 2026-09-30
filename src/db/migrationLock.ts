import Database from "better-sqlite3";

/**
 * Run `fn` while holding an exclusive lock on `lockFile`, so several
 * processes (spec 25 decision 8: the `web` and `worker` roles booting one
 * data directory at once) can each call migrate() and only one of them
 * actually applies anything — the others block, then find the work done.
 *
 * The lock is a tiny SQLite database used purely for its file lock, not a
 * lock file: if the holder dies mid-migration the OS drops the lock with the
 * process, whereas a stale lock file would wedge every later boot.
 *
 * Why drizzle's own migrate() cannot be the lock: it first reads the applied
 * migrations table and only then opens a deferred `BEGIN`, so two fresh
 * processes both see nothing applied, both decide to run the first migration,
 * and the loser fails on `CREATE TABLE`.
 *
 * Why the lock is not taken on the main connection: migrate() opens its own
 * transaction, and a nested `BEGIN` is illegal in SQLite — so the exclusive
 * transaction lives on a separate handle to a separate file.
 */
export function withMigrationLock<T>(lockFile: string, fn: () => T, timeoutMs = 60_000): T {
  const lock = new Database(lockFile, { timeout: timeoutMs });
  try {
    // SQLite's busy handler blocks here (up to `timeoutMs`) while another
    // process holds the exclusive transaction, then throws SQLITE_BUSY.
    lock.exec("BEGIN EXCLUSIVE");
    try {
      return fn();
    } finally {
      lock.exec("COMMIT");
    }
  } finally {
    // Outer finally so a failed BEGIN also closes the handle.
    lock.close();
  }
}
