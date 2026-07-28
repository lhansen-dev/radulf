import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  isValidBranchName,
  listBranches,
  worktreeIsDirty,
  worktreeDiff,
  worktreeDiffStat,
  worktreeChangedPaths,
} from "./git";

function git(dir: string, ...args: string[]) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

describe("listBranches", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-git-test-"));
    // Init a git repo
    git(tmpDir, "init");
    // Set user config so commits work
    git(tmpDir, "config", "user.email", "test@test.com");
    git(tmpDir, "config", "user.name", "Test");
    // Create initial commit (creates default branch, typically "master" or "main")
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# test");
    git(tmpDir, "add", ".");
    git(tmpDir, "commit", "-m", "initial");
    // Create a second branch
    git(tmpDir, "branch", "feature-x");
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the default branch and the extra branch", async () => {
    const branches = await listBranches(tmpDir);
    expect(branches).toContain("feature-x");
    // Should contain either "main" or "master" depending on git config
    const hasDefault = branches.includes("main") || branches.includes("master");
    expect(hasDefault).toBe(true);
    expect(branches.length).toBeGreaterThanOrEqual(2);
  });

  it("returns [] for a non-git directory", async () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-no-git-"));
    try {
      const branches = await listBranches(nonGitDir);
      expect(branches).toEqual([]);
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it("returns [] for a non-existent path", async () => {
    const branches = await listBranches("/tmp/nonexistent-ralph-test-path-12345");
    expect(branches).toEqual([]);
  });
});

describe("isValidBranchName", () => {
  it.each(["feature/task", "release-1.2", "user/name"])('accepts "%s"', async (name) => {
    expect(await isValidBranchName(name)).toBe(true);
  });

  it.each(["-dangerous-option", "bad..name", "bad name", "main~1", ""])('rejects "%s"', async (name) => {
    expect(await isValidBranchName(name)).toBe(false);
  });
});

describe("worktreeIsDirty", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-dirty-test-"));
    git(tmpDir, "init");
    git(tmpDir, "config", "user.email", "test@test.com");
    git(tmpDir, "config", "user.name", "Test");
    fs.writeFileSync(path.join(tmpDir, "README.md"), "# test");
    git(tmpDir, "add", ".");
    git(tmpDir, "commit", "-m", "initial");
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns false for a clean worktree", async () => {
    expect(await worktreeIsDirty(tmpDir)).toBe(false);
  });

  it("returns true when an untracked file exists", async () => {
    fs.writeFileSync(path.join(tmpDir, "newfile.txt"), "hello");
    expect(await worktreeIsDirty(tmpDir)).toBe(true);
    fs.rmSync(path.join(tmpDir, "newfile.txt"));
  });

  it("returns true when a tracked file is modified", async () => {
    fs.writeFileSync(path.join(tmpDir, "README.md"), "modified");
    expect(await worktreeIsDirty(tmpDir)).toBe(true);
    git(tmpDir, "checkout", "--", "README.md");
  });

  it("returns false for a non-existent path", async () => {
    expect(await worktreeIsDirty("/tmp/nonexistent-ralph-test-path-12345")).toBe(false);
  });
});

describe("review diff generation (worktreeDiff / worktreeDiffStat / worktreeChangedPaths)", () => {
  let tmpDir: string;
  let defaultBranch: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-diff-test-"));
    git(tmpDir, "init");
    git(tmpDir, "config", "user.email", "test@test.com");
    git(tmpDir, "config", "user.name", "Test");
    fs.writeFileSync(path.join(tmpDir, "README.md"), "line1\n");
    git(tmpDir, "add", ".");
    git(tmpDir, "commit", "-m", "initial");
    defaultBranch = execFileSync("git", ["-C", tmpDir, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
    }).trim();
    git(tmpDir, "checkout", "-b", "agent-branch");
    fs.writeFileSync(path.join(tmpDir, "README.md"), "line1\nline2\n");
    git(tmpDir, "add", ".");
    git(tmpDir, "commit", "-m", "agent change");
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("shows the real content diff and stat for ordinary changes", async () => {
    const diff = await worktreeDiff(tmpDir, defaultBranch);
    expect(diff).toContain("+line2");
    const stat = await worktreeDiffStat(tmpDir, defaultBranch);
    expect(stat).toMatch(/1 file changed/);
  });

  it("lists changed paths, excluding .ralph", async () => {
    fs.mkdirSync(path.join(tmpDir, ".ralph"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".ralph", "SUMMARY.md"), "loop notes");
    git(tmpDir, "add", "-A");
    git(tmpDir, "commit", "-m", "loop artifacts");

    const paths = await worktreeChangedPaths(tmpDir, defaultBranch);
    expect(paths).toContain("README.md");
    expect(paths.some((p) => p.startsWith(".ralph/"))).toBe(false);
  });

  it("--text defeats a .gitattributes `-diff` entry that would otherwise hide content as binary", async () => {
    fs.writeFileSync(path.join(tmpDir, ".gitattributes"), "secret.txt -diff\n");
    fs.writeFileSync(path.join(tmpDir, "secret.txt"), "TOP SECRET PAYLOAD\n");
    git(tmpDir, "add", "-A");
    git(tmpDir, "commit", "-m", "add secret with -diff attribute");

    // Sanity check: without our hardening flags, git actually does suppress it.
    const unhardened = execFileSync(
      "git",
      ["-C", tmpDir, "diff", defaultBranch, "HEAD", "--", "secret.txt"],
      { encoding: "utf8" },
    );
    expect(unhardened).toContain("Binary files");
    expect(unhardened).not.toContain("TOP SECRET PAYLOAD");

    const diff = await worktreeDiff(tmpDir, defaultBranch);
    expect(diff).toContain("TOP SECRET PAYLOAD");
    expect(diff).not.toContain("Binary files");
  });

  it("--no-ext-diff refuses a diff driver planted in local git config", async () => {
    git(tmpDir, "config", "diff.evil.textconv", "echo FABRICATED-BY-DRIVER");
    fs.writeFileSync(path.join(tmpDir, ".gitattributes"), "secret.txt -diff\nREADME.md diff=evil\n");
    git(tmpDir, "add", "-A");
    git(tmpDir, "commit", "-m", "wire up a diff driver");
    fs.writeFileSync(path.join(tmpDir, "README.md"), "line1\nline2\nline3\n");
    git(tmpDir, "add", "-A");
    git(tmpDir, "commit", "-m", "change under the hijacked driver");

    const diff = await worktreeDiff(tmpDir, defaultBranch);
    expect(diff).not.toContain("FABRICATED-BY-DRIVER");
    expect(diff).toContain("+line3");

    git(tmpDir, "config", "--unset", "diff.evil.textconv");
  });
});
