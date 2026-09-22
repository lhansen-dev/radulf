import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  createWorktree,
  hasCommits,
  isRalphBranch,
  isValidBranchName,
  listBranches,
  offRunBranchReason,
  worktreeIsDirty,
  worktreeDiff,
  worktreeDiffStat,
  worktreeChangedPaths,
} from "./git";

function git(dir: string, ...args: string[]) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

describe("repository inspection", () => {
  let repo: string;
  let emptyRepo: string;
  let nonGitDir: string;
  const missingPath = "/tmp/nonexistent-ralph-test-path-12345";

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-git-test-"));
    git(repo, "init");
    git(repo, "config", "user.email", "test@test.com");
    git(repo, "config", "user.name", "Test");
    fs.writeFileSync(path.join(repo, "README.md"), "# test");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "initial");
    git(repo, "branch", "feature-x");
    emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-empty-repo-"));
    git(emptyRepo, "init");
    nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-no-git-"));
  });

  afterAll(() => {
    for (const d of [repo, emptyRepo, nonGitDir]) fs.rmSync(d, { recursive: true, force: true });
  });

  it("listBranches returns every branch, or [] outside a git repo", async () => {
    const branches = await listBranches(repo);
    expect(branches).toContain("feature-x");
    expect(branches.includes("main") || branches.includes("master")).toBe(true);
    expect(await listBranches(nonGitDir)).toEqual([]);
    expect(await listBranches(missingPath)).toEqual([]);
  });

  it("hasCommits is true only for a repo with at least one commit", async () => {
    expect(await hasCommits(repo)).toBe(true);
    expect(await hasCommits(emptyRepo)).toBe(false);
    expect(await hasCommits(nonGitDir)).toBe(false);
  });

  it("createWorktree names an empty repo or missing base branch instead of a raw git error", async () => {
    await expect(createWorktree(emptyRepo, "main", "My task", "run1")).rejects.toThrow(
      /has no commits yet/,
    );
    await expect(createWorktree(repo, "nope", "My task", "run2")).rejects.toThrow(
      /base branch "nope" does not exist/,
    );
  });

  it("offRunBranchReason is null on the run branch, and names where the worktree went otherwise", async () => {
    const wt = path.join(os.tmpdir(), `ralph-offbranch-wt-${process.pid}`);
    git(repo, "worktree", "add", "-q", wt, "-b", "ralph/run-1");
    try {
      expect(await offRunBranchReason(wt, "ralph/run-1")).toBeNull();
      // The incident shape: the agent checks out a branch nothing else has.
      git(wt, "checkout", "-q", "feature-x");
      expect(await offRunBranchReason(wt, "ralph/run-1")).toBe(
        "worktree left its run branch: on feature-x, expected ralph/run-1",
      );
      git(wt, "checkout", "-q", "--detach");
      expect(await offRunBranchReason(wt, "ralph/run-1")).toBe(
        "worktree left its run branch: on a detached HEAD, expected ralph/run-1",
      );
    } finally {
      git(repo, "worktree", "remove", "--force", wt);
    }
  });

  it("worktreeIsDirty sees untracked and modified files, and is false for a missing path", async () => {
    expect(await worktreeIsDirty(repo)).toBe(false);
    expect(await worktreeIsDirty(missingPath)).toBe(false);

    fs.writeFileSync(path.join(repo, "newfile.txt"), "hello");
    expect(await worktreeIsDirty(repo)).toBe(true);
    fs.rmSync(path.join(repo, "newfile.txt"));

    fs.writeFileSync(path.join(repo, "README.md"), "modified");
    expect(await worktreeIsDirty(repo)).toBe(true);
    git(repo, "checkout", "--", "README.md");
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

describe("isRalphBranch", () => {
  it.each(["ralph/fix-the-thing-abc123", "ralph/improve-1753500000000"])('claims "%s"', (name) => {
    expect(isRalphBranch(name)).toBe(true);
  });

  it.each(["main", "feature/ralph", "ralph", "ralph-notes"])('leaves "%s" alone', (name) => {
    expect(isRalphBranch(name)).toBe(false);
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
