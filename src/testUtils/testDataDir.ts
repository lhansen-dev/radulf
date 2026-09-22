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
  const previous = process.env.RADULF_DATA_DIR;
  process.env.RADULF_DATA_DIR = dir;
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.RADULF_DATA_DIR;
    else process.env.RADULF_DATA_DIR = previous;
  });
  return dir;
}
