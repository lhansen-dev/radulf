import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

const testDataDir = setupTestDataDir("radulf-db-mode-");

const { db, repos } = await import("./index");

describe("the SQLite file", () => {
  it("is readable only by its owner, along with the WAL it spawns", () => {
    db.select().from(repos).all(); // opens the connection and writes the WAL

    const mode = (file: string) => fs.statSync(path.join(testDataDir, file)).mode & 0o777;
    expect(mode("radulf.db")).toBe(0o600);
    // SQLite copies the database file's mode onto the files it creates beside
    // it, which is why the chmod has to land before journal_mode = WAL.
    expect(mode("radulf.db-wal")).toBe(0o600);
  });
});
