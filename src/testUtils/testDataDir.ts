import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

/**
 * Point RADULF_DATA_DIR at a fresh temp dir for the rest of the test file and
 * return its path. Removes the dir and restores the previous value in an
 * `afterAll`.
 *
 * The data dir sits one level down (`<root>/data`) so the siblings Radulf
 * derives from it (worktrees/, plans/, repos/, runtmp/) land inside the temp
 * root too. Directly in the system temp dir they would be shared by every
 * test file, and an orchestrator booting in one file sweeps runtmp/ of the
 * run dirs another file is using.
 *
 * `@/db` resolves DATA_DIR from the env var when it loads, so call this at
 * module top level, before the file's `await import("@/db")` and before
 * importing anything that loads it.
 */
export function setupTestDataDir(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dir = path.join(root, "data");
  fs.mkdirSync(dir);
  pointDataDirAt(dir, root);
  return dir;
}

/** Like setupTestDataDir, but returns the temp root rather than the data dir. */
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
