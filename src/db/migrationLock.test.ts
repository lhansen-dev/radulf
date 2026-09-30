import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withMigrationLock } from "./migrationLock";

// Deliberately does not import "@/db": the lock must be testable without a
// data dir, and "another process" is just a second better-sqlite3 handle on
// the same file — SQLite's locking is per-connection, not per-process.
describe("withMigrationLock", () => {
  let tmp: string;
  let lockFile: string;
  let other: InstanceType<typeof Database>;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-migration-lock-"));
    lockFile = path.join(tmp, "radulf-migrate.lock");
    other = new Database(lockFile);
  });

  afterAll(() => {
    try {
      if (other.inTransaction) other.exec("COMMIT");
    } finally {
      other.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("times out with SQLITE_BUSY while another connection holds the lock, without running fn", () => {
    other.exec("BEGIN EXCLUSIVE");
    let called = false;
    expect(() =>
      withMigrationLock(
        lockFile,
        () => {
          called = true;
        },
        200
      )
    ).toThrow(/SQLITE_BUSY|database is locked/);
    expect(called).toBe(false);
  });

  it("runs fn and returns its value once the other connection commits, then releases the lock", () => {
    other.exec("COMMIT");
    expect(withMigrationLock(lockFile, () => 42)).toBe(42);
    // Released: the other connection can take the exclusive lock again at once.
    expect(() => other.exec("BEGIN EXCLUSIVE")).not.toThrow();
    other.exec("COMMIT");
  });
});
