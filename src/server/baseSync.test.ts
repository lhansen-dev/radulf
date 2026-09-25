import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { git, initScratchRepo } from "@/testUtils/gitRepo";
import { abortMerge, mergeInProgress, resolveConflictsTaskText, syncWithBase } from "./baseSync";

describe("syncWithBase (spec 29)", () => {
  let repo: string;
  let wt: string;
  let base: string;

  beforeEach(() => {
    repo = initScratchRepo("ralph-basesync-");
    base = git(repo, "rev-parse", "--abbrev-ref", "HEAD");
    wt = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-basesync-wt-"));
    fs.rmSync(wt, { recursive: true, force: true });
    git(repo, "worktree", "add", wt, "-b", "ralph/x");
    git(wt, "config", "user.email", "test@test.com");
    git(wt, "config", "user.name", "Test");
    fs.writeFileSync(path.join(wt, "work.ts"), "export const work = 1;\n");
    git(wt, "add", ".");
    git(wt, "commit", "-m", "loop work");
  });

  afterEach(() => {
    fs.rmSync(wt, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("returns up-to-date and leaves HEAD alone when the base has not moved", async () => {
    expect(await mergeInProgress(wt)).toBe(false);
    const before = git(wt, "rev-parse", "HEAD");
    expect(await syncWithBase(wt, base, "ralph/x")).toEqual({ status: "up-to-date" });
    expect(git(wt, "rev-parse", "HEAD")).toBe(before);
  });

  it("creates a merge commit when the base changed a different file", async () => {
    fs.writeFileSync(path.join(repo, "other.ts"), "export const other = 2;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "base moves");

    const result = await syncWithBase(wt, base, "ralph/x");
    expect(result.status).toBe("merged");
    if (result.status !== "merged") throw new Error("unreachable");
    expect(result.mergeCommit).toBe(git(wt, "rev-parse", "HEAD"));
    const parents = git(wt, "rev-list", "--parents", "-n", "1", "HEAD").split(/\s+/);
    expect(parents).toHaveLength(3);
    expect(git(wt, "log", "-1", "--format=%s")).toMatch(/^ralph: merge/);
    expect(fs.existsSync(path.join(wt, "other.ts"))).toBe(true);
  });

  it("leaves a conflicted merge in progress, and abortMerge clears it", async () => {
    fs.writeFileSync(path.join(repo, "work.ts"), "export const work = 'base';\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "base edits same file");

    const result = await syncWithBase(wt, base, "ralph/x");
    expect(result.status).toBe("conflicted");
    if (result.status !== "conflicted") throw new Error("unreachable");
    expect(result.files).toEqual(["work.ts"]);
    expect(fs.readFileSync(path.join(wt, "work.ts"), "utf8")).toContain("<<<<<<<");
    expect(fs.statSync(path.join(wt, ".git")).isFile()).toBe(true);
    expect(() => git(wt, "rev-parse", "-q", "--verify", "MERGE_HEAD")).not.toThrow();
    expect(await mergeInProgress(wt)).toBe(true);

    await abortMerge(wt);
    expect(() => git(wt, "rev-parse", "-q", "--verify", "MERGE_HEAD")).toThrow();
    expect(await mergeInProgress(wt)).toBe(false);
    expect(fs.readFileSync(path.join(wt, "work.ts"), "utf8")).not.toContain("<<<<<<<");
  });

  it("resolveConflictsTaskText names the files and base branch", () => {
    const text = resolveConflictsTaskText("main", ["a.ts", "b.ts"]);
    expect(
      text.startsWith(
        "Resolve the merge conflicts left in a.ts, b.ts after the orchestrator merged the base branch main into your branch.",
      ),
    ).toBe(true);
    expect(text).toContain("git diff --check");
  });
});

describe("syncWithBase on a rewritten base", () => {
  let repo: string;
  let wt: string;
  let base: string;
  /** The base commit the branch forked from, rewritten by the tests below. */
  let forkPoint: string;

  const commit = (cwd: string, file: string, content: string, subject: string) => {
    fs.writeFileSync(path.join(cwd, file), content);
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", subject);
    return git(cwd, "rev-parse", "HEAD");
  };
  const subjects = (cwd: string, range: string) =>
    git(cwd, "log", "--format=%s", range).split("\n").filter((l) => l !== "");

  beforeEach(() => {
    repo = initScratchRepo("ralph-basesync-rewrite-");
    base = git(repo, "rev-parse", "--abbrev-ref", "HEAD");
    forkPoint = commit(repo, "jira.ts", "export const jira = 1;\n", "feat: jira v1");
    wt = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-basesync-rewrite-wt-"));
    fs.rmSync(wt, { recursive: true, force: true });
    git(repo, "worktree", "add", wt, "-b", "ralph/x");
    git(wt, "config", "user.email", "test@test.com");
    git(wt, "config", "user.name", "Test");
    // Radulf's own commits, as the orchestrator writes them: the plan first,
    // then one commit per finished task.
    commit(wt, "prompt.md", "prompt\n", "ralph: plan v1 for x");
    commit(wt, "work.ts", "export const work = 1;\n", "ralph: task 1: work");
  });

  afterEach(() => {
    fs.rmSync(wt, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("replays the branch's own commits onto a base whose commit was amended under it", async () => {
    // The commit the branch forked from is amended on the base: same file,
    // different content and subject, so the old one is no longer an ancestor.
    fs.writeFileSync(path.join(repo, "jira.ts"), "export const jira = 2;\n");
    git(repo, "add", ".");
    git(repo, "commit", "--amend", "-m", "feat: jira v2");
    expect(() => git(repo, "merge-base", "--is-ancestor", forkPoint, base)).toThrow();

    const result = await syncWithBase(wt, base, "ralph/x");
    expect(result).toEqual({
      status: "rebased",
      onto: git(repo, "rev-parse", base),
      replayed: 2,
      dropped: [forkPoint],
    });
    // Only Radulf's commits remain above the base, in order, on the branch.
    expect(subjects(wt, `${base}..HEAD`)).toEqual(["ralph: task 1: work", "ralph: plan v1 for x"]);
    expect(git(wt, "symbolic-ref", "HEAD")).toBe("refs/heads/ralph/x");
    expect(() => git(wt, "merge-base", "--is-ancestor", base, "HEAD")).not.toThrow();
    // The new base's content won; the branch's own work is intact.
    expect(fs.readFileSync(path.join(wt, "jira.ts"), "utf8")).toContain("jira = 2");
    expect(fs.readFileSync(path.join(wt, "work.ts"), "utf8")).toContain("work = 1");
    expect(await mergeInProgress(wt)).toBe(false);
  });

  it("falls back to the merge, branch untouched, when the replay itself conflicts", async () => {
    // The rewritten base adds the very file the task commit adds.
    fs.writeFileSync(path.join(repo, "work.ts"), "export const work = 'base';\n");
    git(repo, "add", ".");
    git(repo, "commit", "--amend", "-m", "feat: jira v2 plus work");
    const before = git(wt, "rev-parse", "HEAD");

    const result = await syncWithBase(wt, base, "ralph/x");
    expect(result.status).toBe("conflicted");
    if (result.status !== "conflicted") throw new Error("unreachable");
    expect(result.files).toEqual(["work.ts"]);
    expect(git(wt, "symbolic-ref", "HEAD")).toBe("refs/heads/ralph/x");
    expect(git(wt, "rev-parse", "ralph/x")).toBe(before);
    expect(await mergeInProgress(wt)).toBe(true);
    expect(() => git(wt, "rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD")).toThrow();
  });

  it("still merges when the base merely moved forward", async () => {
    commit(repo, "other.ts", "export const other = 2;\n", "feat: base moves");

    const result = await syncWithBase(wt, base, "ralph/x");
    expect(result.status).toBe("merged");
    expect(subjects(wt, `${base}..HEAD`)).toEqual([
      "ralph: merge " + base + " into ralph/x",
      "ralph: task 1: work",
      "ralph: plan v1 for x",
    ]);
  });

  it("does not replay a branch someone else committed on", async () => {
    commit(wt, "manual.ts", "export const manual = 1;\n", "hand edit in the worktree");
    fs.writeFileSync(path.join(repo, "jira.ts"), "export const jira = 2;\n");
    git(repo, "add", ".");
    git(repo, "commit", "--amend", "-m", "feat: jira v2");
    const before = git(wt, "rev-parse", "HEAD");

    const result = await syncWithBase(wt, base, "ralph/x");
    expect(result.status).toBe("conflicted");
    if (result.status !== "conflicted") throw new Error("unreachable");
    expect(result.files).toEqual(["jira.ts"]);
    expect(git(wt, "rev-parse", "ralph/x")).toBe(before);
  });
});
