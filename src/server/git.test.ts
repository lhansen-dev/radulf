import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { git, initScratchRepo } from "@/testUtils/gitRepo";
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
  mergeBranch,
  offRunBranchReason,
  withRepoMergeLock,
  worktreeIsDirty,
  worktreeDiff,
  worktreeDiffStat,
} from "./git";

describe("repository inspection", () => {
  let repo: string;
  let emptyRepo: string;
  let nonGitDir: string;
  const missingPath = "/tmp/nonexistent-ralph-test-path-12345";

  beforeAll(() => {
    repo = initScratchRepo("ralph-git-test-");
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

describe("review diff generation (worktreeDiff / worktreeDiffStat)", () => {
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

  it("excludes .ralph from the diff and the stat", async () => {
    fs.mkdirSync(path.join(tmpDir, ".ralph"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".ralph", "SUMMARY.md"), "loop notes");
    git(tmpDir, "add", "-A");
    git(tmpDir, "commit", "-m", "loop artifacts");

    const diff = await worktreeDiff(tmpDir, defaultBranch);
    expect(diff).toContain("README.md");
    expect(diff).not.toContain("loop notes");
    expect(await worktreeDiffStat(tmpDir, defaultBranch)).toMatch(/1 file changed/);
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

  it("core.quotePath=false keeps a non-ASCII path readable in the diff --git header", async () => {
    // The review page prefix-matches these paths to decide whether to raise
    // its sandbox/self-modifying banners, so a C-quoted header is a banner
    // that never fires. See diffHeader.ts.
    fs.mkdirSync(path.join(tmpDir, "src", "server", "sandbox"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "server", "sandbox", "café.ts"), "export {};\n");
    git(tmpDir, "add", "-A");
    git(tmpDir, "commit", "-m", "add a non-ascii path under the sandbox dir");

    // Sanity check: git's default really does quote it.
    const unhardened = execFileSync(
      "git",
      ["-C", tmpDir, "diff", defaultBranch, "HEAD", "--", "src/"],
      { encoding: "utf8" },
    );
    expect(unhardened).toContain(String.raw`"a/src/server/sandbox/caf\303\251.ts"`);

    const diff = await worktreeDiff(tmpDir, defaultBranch);
    expect(diff).toContain("diff --git a/src/server/sandbox/café.ts b/src/server/sandbox/café.ts");
    expect(diff).not.toContain(String.raw`caf\303\251`);
  });
});

describe("withRepoMergeLock", () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("never lets two calls for the same key run at once, even when one throws", async () => {
    const events: string[] = [];
    let active = 0;
    let sawOverlap = false;
    const task = (label: string, ms: number, fail: boolean) => async () => {
      active++;
      if (active > 1) sawOverlap = true;
      events.push(`${label}:enter`);
      await wait(ms);
      active--;
      events.push(`${label}:exit`);
      if (fail) throw new Error(`${label} failed`);
      return label;
    };

    const first = withRepoMergeLock("repo-a", task("first", 20, true));
    const second = withRepoMergeLock("repo-a", task("second", 5, false));

    await expect(first).rejects.toThrow("first failed");
    await expect(second).resolves.toBe("second");
    expect(sawOverlap).toBe(false);
    // "first" throwing must not skip "second" or reorder it ahead of "first".
    expect(events).toEqual(["first:enter", "first:exit", "second:enter", "second:exit"]);
  });

  it("lets calls for different keys run concurrently", async () => {
    const events: string[] = [];
    const task = (label: string, ms: number) => async () => {
      events.push(`${label}:enter`);
      await wait(ms);
      events.push(`${label}:exit`);
    };

    await Promise.all([
      withRepoMergeLock("repo-b", task("b", 20)),
      withRepoMergeLock("repo-c", task("c", 5)),
    ]);

    // Different repos don't wait on each other, so the shorter task ("c")
    // exits before the longer one ("b") — a shared lock would force "b" to
    // exit first since it was queued first.
    expect(events).toEqual(["b:enter", "c:enter", "c:exit", "b:exit"]);
  });

  it("a repo whose lock is still held by a slow call does not block a fast call on another repo", async () => {
    const start = Date.now();
    let dTook = 0;
    const slow = withRepoMergeLock("repo-slow", async () => wait(40));
    const fast = withRepoMergeLock("repo-fast", async () => {
      dTook = Date.now() - start;
    });
    await Promise.all([slow, fast]);
    // "repo-fast" must not have waited behind "repo-slow"'s 40ms hold.
    expect(dTook).toBeLessThan(30);
  });
});

describe("mergeBranch concurrency (spec 20: different cards, same repo)", () => {
  let tmpDir: string;
  let defaultBranch: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-merge-concurrency-"));
    git(tmpDir, "init");
    git(tmpDir, "config", "user.email", "test@test.com");
    git(tmpDir, "config", "user.name", "Test");
    fs.writeFileSync(path.join(tmpDir, "README.md"), "base\n");
    git(tmpDir, "add", ".");
    git(tmpDir, "commit", "-m", "initial");
    defaultBranch = execFileSync("git", ["-C", tmpDir, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
    }).trim();

    // Two feature branches touching different files, as two different cards'
    // run branches would — nothing here should conflict on content.
    git(tmpDir, "checkout", "-b", "ralph/card-a");
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "a\n");
    git(tmpDir, "add", ".");
    git(tmpDir, "commit", "-m", "card a change");
    git(tmpDir, "checkout", defaultBranch);

    git(tmpDir, "checkout", "-b", "ralph/card-b");
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "b\n");
    git(tmpDir, "add", ".");
    git(tmpDir, "commit", "-m", "card b change");
    git(tmpDir, "checkout", defaultBranch);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("two cards' merges against the same shared repo checkout don't clobber each other", async () => {
    // Without the per-repo lock, these interleave on the same index the way
    // the bug describes: one's `--no-commit` merge can be clobbered by the
    // other's `status --porcelain` still reading clean before the first
    // commits. Firing them together via Promise.all is the reproduction.
    const [resultA, resultB] = await Promise.all([
      mergeBranch(tmpDir, defaultBranch, "ralph/card-a", "ralph: merge card a"),
      mergeBranch(tmpDir, defaultBranch, "ralph/card-b", "ralph: merge card b"),
    ]);

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    expect(resultA.mergeCommit).not.toBe(resultB.mergeCommit);

    // Both changes landed, and each merge produced its own commit — the
    // interleaved-index failure mode either drops one card's diff or merges
    // both under one commit message.
    expect(fs.existsSync(path.join(tmpDir, "a.txt"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "b.txt"))).toBe(true);
    const log = execFileSync("git", ["-C", tmpDir, "log", "--oneline", defaultBranch], {
      encoding: "utf8",
    });
    expect(log).toContain("ralph: merge card a");
    expect(log).toContain("ralph: merge card b");

    expect(await hasCommits(tmpDir)).toBe(true);
    expect(execFileSync("git", ["-C", tmpDir, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
    }).trim()).toBe(defaultBranch);
  });
});
