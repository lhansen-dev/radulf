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
