import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

const testDataDir = setupTestDataDir("radulf-db-mode-");

const { db, repos } = await import("./index");

const mode = (file: string) => fs.statSync(path.join(testDataDir, file)).mode & 0o777;

describe("the SQLite files", () => {
  it("are readable only by their owner, WAL and shared-memory included", () => {
    db.select().from(repos).all(); // opens the connection and writes the WAL

    // The main file is tightened before `journal_mode = WAL`, so SQLite
    // copies 0600 onto what it creates; the -wal and -shm are then tightened
    // by name as well, because an install that already had them at 0644 keeps
    // them, and the WAL is where the most recent writes live.
    expect(mode("radulf.db")).toBe(0o600);
    expect(mode("radulf.db-wal")).toBe(0o600);
    expect(mode("radulf.db-shm")).toBe(0o600);
  });
});
