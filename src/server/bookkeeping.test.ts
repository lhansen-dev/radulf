import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildProgressState,
  captureIterationState,
  deterministicCommitMessage,
  hasIterationWorkProduct,
  performIterationBookkeeping,
} from "./bookkeeping";
import { tryGit } from "./git";

// Direct unit tests for bookkeeping.ts's two functions PLAN.md Phase 11 calls
// out by name. deterministicCommitMessage is already exercised (happy path)
// in orchestrator.test.ts; hasIterationWorkProduct too (clean-pre-state
// cases). The cases below cover boundaries neither already hits — see each
// describe block for what's new.

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
  it("returns false when absolutely nothing changed since the pre-snapshot", async () => {
    const dir = await initRepo();
    try {
      const pre = await captureIterationState(dir);
      expect(await hasIterationWorkProduct(dir, pre)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns true when uncommitted work predates the iteration and nothing changed during it", async () => {
    const dir = await initRepo();
    try {
      // An earlier iteration edited a file and then failed before signalling,
      // so its work was never committed. Only loop agents leave a worktree
      // dirty — every other writer commits — so this is creditable work.
      fs.writeFileSync(path.join(dir, "feature.ts"), "export const x = 1;");
      const pre = await captureIterationState(dir);

      // This iteration finds the task already done: it only signals.
      fs.writeFileSync(path.join(dir, "ITERATION_DONE"), "verified the existing edit");
      expect(await hasIterationWorkProduct(dir, pre)).toBe(true);
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

      // Same "one untracked file" shape, but a different filename.
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

describe("buildProgressState content sensitivity", () => {
  it("changes when an already-modified tracked file is edited again", async () => {
    const dir = await initRepo();
    try {
      const planPath = path.join(dir, "PLAN.md");
      fs.writeFileSync(path.join(dir, "PLAN.md"), "## Tasks\n- [ ] item 1\n- [ ] edited once\n");
      const before = await buildProgressState(dir, planPath);

      // `git status --porcelain` reads " M PLAN.md" both times.
      fs.writeFileSync(path.join(dir, "PLAN.md"), "## Tasks\n- [ ] item 1\n- [ ] edited twice\n");
      expect(await buildProgressState(dir, planPath)).not.toBe(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("changes when an existing untracked file is edited in place", async () => {
    const dir = await initRepo();
    try {
      const planPath = path.join(dir, "missing-plan.md");
      fs.writeFileSync(path.join(dir, "draft.ts"), "v1");
      const before = await buildProgressState(dir, planPath);

      fs.writeFileSync(path.join(dir, "draft.ts"), "v2");
      expect(await buildProgressState(dir, planPath)).not.toBe(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stays identical when a dirty worktree is left untouched", async () => {
    const dir = await initRepo();
    try {
      const planPath = path.join(dir, "missing-plan.md");
      fs.writeFileSync(path.join(dir, "PLAN.md"), "modified");
      fs.writeFileSync(path.join(dir, "draft.ts"), "v1");
      const before = await buildProgressState(dir, planPath);
      expect(await buildProgressState(dir, planPath)).toBe(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("performIterationBookkeeping after a failed iteration", () => {
  it("commits work a failed iteration left behind when the next one only signals", async () => {
    const dir = await initRepo();
    const stateDir = fs.mkdtempSync("/tmp/ralph-plan-");
    try {
      // The private plan lives outside the worktree, as in production.
      const planPath = path.join(stateDir, "PLAN.md");
      fs.writeFileSync(planPath, "## Tasks\n- [x] item 1\n- [ ] item 2\n- [ ] item 3\n");
      const ralphDir = path.join(dir, ".ralph");
      fs.mkdirSync(ralphDir);
      fs.writeFileSync(path.join(ralphDir, "PROMPT.md"), "prompt");
      await tryGit(dir, "add", "-A");
      await tryGit(dir, "commit", "-m", "plan");

      // Iteration A implements item 2, then the harness errors out before
      // the agent writes ITERATION_DONE — no bookkeeping runs.
      fs.writeFileSync(path.join(dir, "feature.ts"), "export const x = 1;");

      // Iteration B finds the work done, verifies it, and only signals.
      const pre = await captureIterationState(dir);
      fs.writeFileSync(path.join(ralphDir, "ITERATION_DONE"), "item 2 verified");

      const result = await performIterationBookkeeping({ ralphDir, worktreePath: dir, planPath, pre });

      expect(result).toMatchObject({ advanced: true, taskNumber: 2 });
      expect(fs.readFileSync(planPath, "utf8")).toContain("- [x] item 2");
      expect((await tryGit(dir, "log", "-1", "--format=%s")).out).toBe("ralph: task 2 — item 2 verified");
      expect((await tryGit(dir, "status", "--porcelain")).out).toBe("");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("is still a phantom when the worktree is clean and nothing was committed", async () => {
    const dir = await initRepo();
    try {
      const ralphDir = path.join(dir, ".ralph");
      fs.mkdirSync(ralphDir);
      fs.writeFileSync(path.join(ralphDir, "PROMPT.md"), "prompt");
      await tryGit(dir, "add", "-A");
      await tryGit(dir, "commit", "-m", "plan");

      const pre = await captureIterationState(dir);
      fs.writeFileSync(path.join(ralphDir, "ITERATION_DONE"), "claims item 1 is done");

      const result = await performIterationBookkeeping({
        ralphDir,
        worktreePath: dir,
        planPath: path.join(dir, "PLAN.md"),
        pre,
      });
      expect(result).toMatchObject({ advanced: false, phantom: true, taskNumber: 1 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
