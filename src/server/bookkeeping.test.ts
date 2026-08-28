import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deterministicCommitMessage, hasIterationWorkProduct, captureIterationState } from "./bookkeeping";
import { tryGit } from "./git";

// Direct unit tests for bookkeeping.ts's two functions PLAN.md Phase 11 calls
// out by name. deterministicCommitMessage is already exercised (happy path)
// in orchestrator.test.ts; hasIterationWorkProduct too (clean-pre-state
// cases). The cases below cover boundaries neither already hits — see each
// describe block for what's new.

describe("deterministicCommitMessage", () => {
  it("formats task number and summary verbatim, with an em dash separator", () => {
    expect(deterministicCommitMessage(1, "implemented the thing")).toBe(
      "ralph: task 1 — implemented the thing",
    );
  });

  it("does not special-case task 0 or negative task numbers — it's a pure format, not a validator", () => {
    expect(deterministicCommitMessage(0, "no task selected")).toBe("ralph: task 0 — no task selected");
    expect(deterministicCommitMessage(-1, "should never happen")).toBe(
      "ralph: task -1 — should never happen",
    );
  });

  it("passes an empty summary through unchanged rather than dropping the separator", () => {
    expect(deterministicCommitMessage(2, "")).toBe("ralph: task 2 — ");
  });

  it("does not trim or otherwise alter whitespace/special characters in the summary", () => {
    expect(deterministicCommitMessage(3, "  fixed —  edge case \n")).toBe(
      "ralph: task 3 —   fixed —  edge case \n",
    );
  });
});

describe("hasIterationWorkProduct", () => {
  async function initRepo(): Promise<string> {
    const dir = fs.mkdtempSync("/tmp/ralph-test-");
    await tryGit(dir, "init");
    await tryGit(dir, "config", "user.email", "test@test.com");
    await tryGit(dir, "config", "user.name", "Test");
    fs.writeFileSync(path.join(dir, "PLAN.md"), "## Tasks\n- [ ] item 1\n- [ ] item 2\n");
    await tryGit(dir, "add", "-A");
    await tryGit(dir, "commit", "-m", "initial");
    return dir;
  }

  it("returns false when absolutely nothing changed since the pre-snapshot", async () => {
    const dir = await initRepo();
    try {
      const pre = await captureIterationState(dir);
      expect(await hasIterationWorkProduct(dir, pre)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false when only ITERATION_DONE plus other already-dirty content is unchanged from pre", async () => {
    const dir = await initRepo();
    try {
      // The pre-snapshot itself is already dirty (an untracked file existed
      // BEFORE the iteration ran) — a case the existing orchestrator-level
      // tests never exercise, since they always start from a clean pre-state.
      fs.writeFileSync(path.join(dir, "already-here.txt"), "pre-existing scratch file");
      const pre = await captureIterationState(dir);

      // The iteration only writes the signal file — no new dirt beyond what
      // was already there before it ran.
      fs.writeFileSync(path.join(dir, "ITERATION_DONE"), "claims done");
      expect(await hasIterationWorkProduct(dir, pre)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns true when a dirty pre-state becomes clean (a revert counts as work product)", async () => {
    const dir = await initRepo();
    try {
      fs.writeFileSync(path.join(dir, "scratch.txt"), "will be reverted");
      const pre = await captureIterationState(dir);

      fs.rmSync(path.join(dir, "scratch.txt"));
      fs.writeFileSync(path.join(dir, "ITERATION_DONE"), "reverted the scratch edit");
      expect(await hasIterationWorkProduct(dir, pre)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns true when a dirty pre-state's dirt changes shape, even though HEAD hasn't moved", async () => {
    const dir = await initRepo();
    try {
      fs.writeFileSync(path.join(dir, "draft-a.txt"), "v1");
      const pre = await captureIterationState(dir);

      // Same "one untracked file" shape, but a different filename — a
      // genuinely different status line the naive "was it dirty before, is
      // it dirty now" boolean check would miss (`git status --porcelain`
      // doesn't diff file contents, only paths, so an in-place content edit
      // to the SAME untracked file would not have caught this).
      fs.rmSync(path.join(dir, "draft-a.txt"));
      fs.writeFileSync(path.join(dir, "draft-b.txt"), "renamed and re-edited");
      fs.writeFileSync(path.join(dir, "ITERATION_DONE"), "renamed the draft");
      expect(await hasIterationWorkProduct(dir, pre)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores the signal file specifically, not just any file — an unrelated untracked file still counts", async () => {
    const dir = await initRepo();
    try {
      const pre = await captureIterationState(dir);
      fs.writeFileSync(path.join(dir, "ITERATION_DONE"), "claims done");
      fs.writeFileSync(path.join(dir, "src.ts"), "export {};");
      expect(await hasIterationWorkProduct(dir, pre)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
