import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Run git in `dir` and return its trimmed stdout. Throws on a non-zero exit. */
export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

/**
 * mkdtemp a repo whose only commit adds a README on `branch` (default `main`),
 * with a throwaway committer identity, and return its path. The caller removes
 * the dir.
 */
export function initScratchRepo(prefix: string, opts: { branch?: string } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(dir, "init", "-b", opts.branch ?? "main");
  git(dir, "config", "user.email", "test@test.com");
  git(dir, "config", "user.name", "Test");
  fs.writeFileSync(path.join(dir, "README.md"), "# test");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "initial");
  return dir;
}
