import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

/**
 * Point RADULF_DATA_DIR at a fresh temp dir for the rest of the test file and
 * return its path. Removes the dir and restores the previous value in an
 * `afterAll`.
 *
 * `@/db` resolves DATA_DIR from the env var when it loads, so call this at
 * module top level, before the file's `await import("@/db")` and before
 * importing anything that loads it.
 */
export function setupTestDataDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  pointDataDirAt(dir, dir);
  return dir;
}

/**
 * Like setupTestDataDir, but with the data dir one level down (`<root>/data`)
 * so the siblings Radulf derives from it (worktrees/, plans/, repos/) land
 * inside the temp root too, not in the system temp dir. Returns the root.
 */
export function setupTestStateDir(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  pointDataDirAt(path.join(root, "data"), root);
  return root;
}

function pointDataDirAt(dataDir: string, removeOnExit: string): void {
  const previous = process.env.RADULF_DATA_DIR;
  process.env.RADULF_DATA_DIR = dataDir;
  afterAll(() => {
    fs.rmSync(removeOnExit, { recursive: true, force: true });
    if (previous === undefined) delete process.env.RADULF_DATA_DIR;
    else process.env.RADULF_DATA_DIR = previous;
  });
}
