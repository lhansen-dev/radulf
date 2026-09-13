import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { planningCandidates } from "./orchestrator";
import { planningDestination, renderPlanPrompt } from "./planningService";
import { renderEvaluatorPrompt } from "./evaluationService";
import {
  buildProgressState,
  captureIterationState,
  deterministicCommitMessage,
  buildLoopPrompt,
  hasIterationWorkProduct,
  taskInjectionBlock,
  iterationDonePath,
  readIterationDone,
  performIterationBookkeeping,
  performDoneBookkeeping,
} from "./bookkeeping";
import { tryGit } from "./git";

describe("planningCandidates", () => {
  it("orders queued cards chronologically even when board position disagrees", async () => {
    const cardsByPosition = [
      { id: "newer", repoId: "repo-a", startedAt: "2026-07-16T12:00:00.000Z" },
      { id: "older", repoId: "repo-b", startedAt: "2026-07-16T10:00:00.000Z" },
    ];

    expect(planningCandidates(cardsByPosition, false)).toEqual([
      { cardId: "older", repoId: "repo-b" },
      { cardId: "newer", repoId: "repo-a" },
    ]);
  });

  it("leaves ordinary Todo cards idle while auto-mode is off", async () => {
    expect(
      planningCandidates(
        [{ id: "queued", repoId: "repo-a", startedAt: null }],
        false,
      ),
    ).toEqual([]);
  });

  it("includes the ordered Todo queue while auto-mode is on", async () => {
    const cardsByPosition = [
      { id: "first", repoId: "repo-a", startedAt: null },
      { id: "second", repoId: "repo-b", startedAt: null },
    ];

    expect(planningCandidates(cardsByPosition, true)).toEqual([
      { cardId: "first", repoId: "repo-a" },
      { cardId: "second", repoId: "repo-b" },
    ]);
  });
});

describe("planningDestination", () => {
  it("returns plan_review when reviewPlanBeforeImplementation is true (1)", async () => {
    const card = { reviewPlanBeforeImplementation: 1 as const };
    expect(planningDestination(card)).toBe("plan_review");
  });

  it("returns ready when reviewPlanBeforeImplementation is false (0)", async () => {
    const card = { reviewPlanBeforeImplementation: 0 as const };
    expect(planningDestination(card)).toBe("ready");
  });
});

describe("configurable prompt templates", () => {
  it("renders the planner placeholders and reviewer feedback", async () => {
    const rendered = renderPlanPrompt(
      "{{TITLE}}\n{{DESCRIPTION}}\n{{FEEDBACK_SECTION}}",
      "Add templates",
      "Make prompts configurable",
      "Keep the existing defaults",
    );

    expect(rendered).toContain("Add templates\nMake prompts configurable");
    expect(rendered).toContain("PREVIOUS ATTEMPT — REVIEWER FEEDBACK");
    expect(rendered).toContain("Keep the existing defaults");
  });

  it("renders evaluator placeholders", async () => {
    expect(
      renderEvaluatorPrompt(
        "{{TITLE}}|{{DESCRIPTION}}|{{BASE_BRANCH}}|{{CRITERIA}}",
        "Evaluate me",
        "Card details",
        "main",
        "grep -q health src/app.ts",
      ),
    ).toBe("Evaluate me|Card details|main|grep -q health src/app.ts");
  });
});

describe("deterministicCommitMessage", () => {
  it("formats the commit message correctly", async () => {
    expect(deterministicCommitMessage(1, "implemented the thing")).toBe(
      "ralph: task 1 — implemented the thing",
    );
    expect(deterministicCommitMessage(3, "added tests")).toBe(
      "ralph: task 3 — added tests",
    );
  });
});

describe("buildLoopPrompt", () => {
  it("injects a block with correct task number and LAST_TASK=false for a normal single-line item", async () => {
    const planMd = "## Tasks\n- [ ] implement the widget\n- [ ] test the widget\n";
    const original = "# Original prompt\n";
    const result = buildLoopPrompt(original, planMd);
    expect(result).toContain("Task #1:");
    expect(result).toContain("implement the widget");
    expect(result).toContain("LAST_TASK=false");
    expect(result).toContain("This is your ONLY task");
    expect(result).toContain(original);
  });

  it("preserves multiline item text verbatim in the injected block", async () => {
    const planMd =
      "## Tasks\n" +
      "- [ ] implement the widget\n" +
      "  needs to handle edge cases\n" +
      "  and also support retries\n" +
      "- [ ] test the widget\n";
    const original = "# Original prompt\n";
    const result = buildLoopPrompt(original, planMd);
    // Multiline text should be preserved with \n join
    expect(result).toContain("implement the widget\nneeds to handle edge cases\nand also support retries");
    expect(result).toContain("LAST_TASK=false");
  });

  it("sets LAST_TASK=true when the selected item is the only unchecked item", async () => {
    const planMd = "## Tasks\n- [x] done item\n- [ ] last unchecked item\n";
    const original = "# Original prompt\n";
    const result = buildLoopPrompt(original, planMd);
    expect(result).toContain("Task #2:");
    expect(result).toContain("last unchecked item");
    expect(result).toContain("LAST_TASK=true");
  });

  it("sets LAST_TASK=true when only one item exists and it is unchecked", async () => {
    const planMd = "## Tasks\n- [ ] the only item\n";
    const original = "# Original prompt\n";
    const result = buildLoopPrompt(original, planMd);
    expect(result).toContain("Task #1:");
    expect(result).toContain("the only item");
    expect(result).toContain("LAST_TASK=true");
  });

  it("never mentions PLAN.md — the agent cannot access it", async () => {
    const block = taskInjectionBlock("## Tasks\n- [ ] implement the widget\n");
    expect(block).not.toContain("PLAN.md");
    expect(block).toContain("no task list to consult");
  });

  it("scopes the loop to its one targeted check without naming CRITERIA.md", async () => {
    const block = taskInjectionBlock("## Tasks\n- [ ] implement the widget\n");
    // CRITERIA.md is orchestrator-private now — the loop never sees it, so the
    // injected block need not (and does not) warn the loop off it.
    expect(block).not.toContain("CRITERIA.md");
    expect(block).toContain("Run only the targeted check named in");
  });

  it("keeps whole-card acceptance testing out of the generated loop prompt", async () => {
    const template = fs.readFileSync(path.join(process.cwd(), "src/prompts/plan.md"), "utf8");
    expect(template).toContain("is the evaluator's job, not yours");
    // The skeleton no longer tells the loop about the criteria file at all.
    expect(template).not.toContain("Do NOT read or run\n`.ralph/CRITERIA.md`");
  });

  it("gives the evaluator the injected criteria and sole authority over them", async () => {
    const template = fs.readFileSync(
      path.join(process.cwd(), "src/prompts/evaluate.md"),
      "utf8",
    );
    expect(template).toContain("sole authoritative runner of the whole-card acceptance criteria");
    expect(template).toContain("{{CRITERIA}}");
    expect(template).toContain("the loop ran only task-scoped checks");
    // Criteria arrive injected, not read from a worktree file.
    expect(template).not.toContain(".ralph/CRITERIA.md");
  });

  it("places the injected block before the original prompt and appends no boundary", async () => {
    const planMd = "## Tasks\n- [ ] implement the widget\n";
    const original = "# Original prompt\n";
    const result = buildLoopPrompt(original, planMd);
    expect(result).toBe(`${taskInjectionBlock(planMd)}\n\n${original}`);
    expect(result).not.toContain("Orchestrator verification boundary");
  });

  describe("no fallback — an uninjectable plan is a caller bug", () => {
    it("throws when planMd is empty string", async () => {
      expect(() => buildLoopPrompt("# Original prompt\n", "")).toThrow(/no unchecked task/);
    });

    it("throws when planMd has no ## Tasks heading", async () => {
      expect(() =>
        buildLoopPrompt("# Original prompt\n", "# Some other content\n\n- [ ] orphan item\n"),
      ).toThrow(/no unchecked task/);
    });

    it("throws when all items are checked (no unchecked item)", async () => {
      expect(() =>
        buildLoopPrompt("# Original prompt\n", "## Tasks\n- [x] done item\n- [x] another done\n"),
      ).toThrow(/no unchecked task/);
    });
  });
});

describe("iterationDonePath", () => {
  it("returns the ITERATION_DONE path within the given ralphDir", async () => {
    const result = iterationDonePath("/tmp/ralph-test");
    expect(result).toBe("/tmp/ralph-test/ITERATION_DONE");
  });
});

describe("readIterationDone", () => {
  it("reads the trimmed contents when the file exists", async () => {
    const dir = fs.mkdtempSync("/tmp/ralph-test-");
    try {
      fs.writeFileSync(path.join(dir, "ITERATION_DONE"), "  completed the task  ");
      expect(readIterationDone(dir)).toBe("completed the task");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when the file is missing", async () => {
    const dir = fs.mkdtempSync("/tmp/ralph-test-");
    try {
      expect(readIterationDone(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when the file is empty", async () => {
    const dir = fs.mkdtempSync("/tmp/ralph-test-");
    try {
      fs.writeFileSync(path.join(dir, "ITERATION_DONE"), "");
      expect(readIterationDone(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when the file contains only whitespace", async () => {
    const dir = fs.mkdtempSync("/tmp/ralph-test-");
    try {
      fs.writeFileSync(path.join(dir, "ITERATION_DONE"), "   \n  \n  ");
      expect(readIterationDone(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildProgressState", () => {
  it("includes empty dirty section between HEAD and checklist when worktree is clean", async () => {
    const dir = fs.mkdtempSync("/tmp/ralph-test-");
    try {
      await tryGit(dir, "init");
      await tryGit(dir, "config", "user.email", "test@test.com");
      await tryGit(dir, "config", "user.name", "Test");
      const planMd = "## Tasks\n- [ ] item 1\n";
      fs.writeFileSync(path.join(dir, "PLAN.md"), planMd);
      await tryGit(dir, "add", "-A");
      await tryGit(dir, "commit", "-m", "initial");
      const head = (await tryGit(dir, "rev-parse", "HEAD")).out;

      const planPath = path.join(dir, "PLAN.md");

      const result = await buildProgressState(dir, planPath);
      expect(result).toBe(`${head}\n\n${planMd}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("includes dirty status between HEAD and checklist when worktree has uncommitted changes", async () => {
    const dir = fs.mkdtempSync("/tmp/ralph-test-");
    try {
      await tryGit(dir, "init");
      await tryGit(dir, "config", "user.email", "test@test.com");
      await tryGit(dir, "config", "user.name", "Test");
      fs.writeFileSync(path.join(dir, "readme.md"), "hello");
      await tryGit(dir, "add", "-A");
      await tryGit(dir, "commit", "-m", "initial");
      const head = (await tryGit(dir, "rev-parse", "HEAD")).out;

      // Add an uncommitted file
      fs.writeFileSync(path.join(dir, "newfile.txt"), "dirty");

      const planPath = path.join(dir, "PLAN.md");
      const planMd = "## Tasks\n- [ ] item 1\n";
      fs.writeFileSync(planPath, planMd);

      const result = await buildProgressState(dir, planPath);
      expect(result).toContain(head);
      expect(result).toContain("newfile.txt");
      expect(result).toContain(planMd);
      // The dirty section should appear between HEAD and the checklist
      const headIndex = result.indexOf(head);
      const dirtyIndex = result.indexOf("newfile.txt");
      const checklistIndex = result.indexOf(planMd);
      expect(headIndex).toBeLessThan(dirtyIndex);
      expect(dirtyIndex).toBeLessThan(checklistIndex);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty-string checklist when planPath does not exist", async () => {
    const dir = fs.mkdtempSync("/tmp/ralph-test-");
    try {
      await tryGit(dir, "init");
      await tryGit(dir, "config", "user.email", "test@test.com");
      await tryGit(dir, "config", "user.name", "Test");
      fs.writeFileSync(path.join(dir, "readme.md"), "hello");
      await tryGit(dir, "add", "-A");
      await tryGit(dir, "commit", "-m", "initial");
      const head = (await tryGit(dir, "rev-parse", "HEAD")).out;

      const planPath = path.join(dir, "NONEXISTENT.md");
      const result = await buildProgressState(dir, planPath);
      expect(result).toBe(`${head}\n\n`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("performIterationBookkeeping", () => {
  it("returns null when no ITERATION_DONE signal file exists", async () => {
    const dir = fs.mkdtempSync("/tmp/ralph-test-");
    try {
      // Init a git repo with a PLAN.md
      await tryGit(dir, "init");
      await tryGit(dir, "config", "user.email", "test@test.com");
      await tryGit(dir, "config", "user.name", "Test");
      const planMd = "## Tasks\n- [ ] item 1\n- [ ] item 2\n";
      fs.writeFileSync(path.join(dir, "PLAN.md"), planMd);
      await tryGit(dir, "add", "-A");
      await tryGit(dir, "commit", "-m", "initial");

      const result = await performIterationBookkeeping({
        ralphDir: dir,
        worktreePath: dir,
        planPath: path.join(dir, "PLAN.md"),
      });

      expect(result).toBeNull();

      // PLAN.md should be unchanged
      expect(fs.readFileSync(path.join(dir, "PLAN.md"), "utf8")).toBe(planMd);

      // No new commit should have been made
      const log = (await tryGit(dir, "log", "--oneline")).out;
      expect(log.split("\n").filter(Boolean).length).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks checklist item, removes signal, and commits with deterministic message", async () => {
    const dir = fs.mkdtempSync("/tmp/ralph-test-");
    try {
      // Init a git repo with a PLAN.md
      await tryGit(dir, "init");
      await tryGit(dir, "config", "user.email", "test@test.com");
      await tryGit(dir, "config", "user.name", "Test");
      const planMd = "## Tasks\n- [ ] item 1\n- [ ] item 2\n- [ ] item 3\n";
      fs.writeFileSync(path.join(dir, "PLAN.md"), planMd);
      await tryGit(dir, "add", "-A");
      await tryGit(dir, "commit", "-m", "initial");

      const initialHead = (await tryGit(dir, "rev-parse", "HEAD")).out;

      // Create the ITERATION_DONE signal
      const summary = "implemented the first feature";
      fs.writeFileSync(path.join(dir, "ITERATION_DONE"), summary);

      const result = await performIterationBookkeeping({
        ralphDir: dir,
        worktreePath: dir,
        planPath: path.join(dir, "PLAN.md"),
      });

      // Verify return value
      expect(result).not.toBeNull();
      expect(result!.advanced).toBe(true);
      expect(result!.taskNumber).toBe(1);
      expect(result!.summary).toBe(summary);
      // items 2 and 3 remain unchecked
      expect(result!.advanced && result!.isLast).toBe(false);

      // Signal file should be removed
      expect(fs.existsSync(path.join(dir, "ITERATION_DONE"))).toBe(false);

      // PLAN.md should have item 1 checked
      const updatedPlan = fs.readFileSync(path.join(dir, "PLAN.md"), "utf8");
      expect(updatedPlan).toContain("- [x] item 1");
      expect(updatedPlan).toContain("- [ ] item 2");
      expect(updatedPlan).toContain("- [ ] item 3");

      // A new commit should have been made
      const newHead = (await tryGit(dir, "rev-parse", "HEAD")).out;
      expect(newHead).not.toBe(initialHead);

      // Commit message should be deterministic
      const commitMessage = (await tryGit(dir, "log", "-1", "--format=%s")).out;
      expect(commitMessage).toBe("ralph: task 1 — implemented the first feature");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects last unchecked item correctly", async () => {
    const dir = fs.mkdtempSync("/tmp/ralph-test-");
    try {
      await tryGit(dir, "init");
      await tryGit(dir, "config", "user.email", "test@test.com");
      await tryGit(dir, "config", "user.name", "Test");
      const planMd = "## Tasks\n- [ ] item 1\n";
      fs.writeFileSync(path.join(dir, "PLAN.md"), planMd);
      await tryGit(dir, "add", "-A");
      await tryGit(dir, "commit", "-m", "initial");

      fs.writeFileSync(path.join(dir, "ITERATION_DONE"), "last item done");

      const result = await performIterationBookkeeping({
        ralphDir: dir,
        worktreePath: dir,
        planPath: path.join(dir, "PLAN.md"),
      });

      expect(result).not.toBeNull();
      expect(result!.advanced && result!.isLast).toBe(true);
      expect(result!.taskNumber).toBe(1);

      // Plan should now be fully checked
      const updatedPlan = fs.readFileSync(path.join(dir, "PLAN.md"), "utf8");
      expect(updatedPlan).toContain("- [x] item 1");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles ITERATION_DONE with no unchecked items gracefully", async () => {
    const dir = fs.mkdtempSync("/tmp/ralph-test-");
    try {
      await tryGit(dir, "init");
      await tryGit(dir, "config", "user.email", "test@test.com");
      await tryGit(dir, "config", "user.name", "Test");
      const planMd = "## Tasks\n- [x] item 1\n";
      fs.writeFileSync(path.join(dir, "PLAN.md"), planMd);
      await tryGit(dir, "add", "-A");
      await tryGit(dir, "commit", "-m", "initial");

      const initialHead = (await tryGit(dir, "rev-parse", "HEAD")).out;
      fs.writeFileSync(path.join(dir, "ITERATION_DONE"), "done but nothing to check");

      const result = await performIterationBookkeeping({
        ralphDir: dir,
        worktreePath: dir,
        planPath: path.join(dir, "PLAN.md"),
      });

      // No unchecked items -> returns null
      expect(result).toBeNull();

      // Signal file should still be removed
      expect(fs.existsSync(path.join(dir, "ITERATION_DONE"))).toBe(false);

      // No new commit
      const newHead = (await tryGit(dir, "rev-parse", "HEAD")).out;
      expect(newHead).toBe(initialHead);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("performDoneBookkeeping", () => {
  it("returns null when no DONE file exists", async () => {
    const dir = fs.mkdtempSync("/tmp/ralph-test-");
    try {
      await tryGit(dir, "init");
      await tryGit(dir, "config", "user.email", "test@test.com");
      await tryGit(dir, "config", "user.name", "Test");
      const planMd = "## Tasks\n- [ ] item 1\n- [ ] item 2\n";
      fs.writeFileSync(path.join(dir, "PLAN.md"), planMd);
      await tryGit(dir, "add", "-A");
      await tryGit(dir, "commit", "-m", "initial");

      const result = await performDoneBookkeeping({
        ralphDir: dir,
        worktreePath: dir,
        planPath: path.join(dir, "PLAN.md"),
      });

      expect(result).toBeNull();

      // PLAN.md unchanged
      expect(fs.readFileSync(path.join(dir, "PLAN.md"), "utf8")).toBe(planMd);

      // No new commit
      const log = (await tryGit(dir, "log", "--oneline")).out;
      expect(log.split("\n").filter(Boolean).length).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks the first unchecked item and commits with deterministic message when DONE exists", async () => {
    const dir = fs.mkdtempSync("/tmp/ralph-test-");
    try {
      await tryGit(dir, "init");
      await tryGit(dir, "config", "user.email", "test@test.com");
      await tryGit(dir, "config", "user.name", "Test");
      const planMd = "## Tasks\n- [ ] item 1\n- [ ] item 2\n- [ ] item 3\n";
      fs.writeFileSync(path.join(dir, "PLAN.md"), planMd);
      await tryGit(dir, "add", "-A");
      await tryGit(dir, "commit", "-m", "initial");

      const initialHead = (await tryGit(dir, "rev-parse", "HEAD")).out;

      // Write the DONE file with a TLDR first line
      const doneContent = "implemented the final feature\n\nMore details here.";
      fs.writeFileSync(path.join(dir, "DONE"), doneContent);

      const result = await performDoneBookkeeping({
        ralphDir: dir,
        worktreePath: dir,
        planPath: path.join(dir, "PLAN.md"),
      });

      // Verify return value
      expect(result).not.toBeNull();
      expect(result!.taskNumber).toBe(1);
      expect(result!.summary).toBe("implemented the final feature");

      // PLAN.md should have item 1 checked
      const updatedPlan = fs.readFileSync(path.join(dir, "PLAN.md"), "utf8");
      expect(updatedPlan).toContain("- [x] item 1");
      expect(updatedPlan).toContain("- [ ] item 2");

      // A new commit should have been made
      const newHead = (await tryGit(dir, "rev-parse", "HEAD")).out;
      expect(newHead).not.toBe(initialHead);

      // Commit message should be deterministic
      const commitMessage = (await tryGit(dir, "log", "-1", "--format=%s")).out;
      expect(commitMessage).toBe("ralph: task 1 — implemented the final feature");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles DONE.md file", async () => {
    const dir = fs.mkdtempSync("/tmp/ralph-test-");
    try {
      await tryGit(dir, "init");
      await tryGit(dir, "config", "user.email", "test@test.com");
      await tryGit(dir, "config", "user.name", "Test");
      const planMd = "## Tasks\n- [ ] item 1\n";
      fs.writeFileSync(path.join(dir, "PLAN.md"), planMd);
      await tryGit(dir, "add", "-A");
      await tryGit(dir, "commit", "-m", "initial");

      // Write DONE.md instead of DONE
      fs.writeFileSync(path.join(dir, "DONE.md"), "done with DONE.md");

      const result = await performDoneBookkeeping({
        ralphDir: dir,
        worktreePath: dir,
        planPath: path.join(dir, "PLAN.md"),
      });

      expect(result).not.toBeNull();
      expect(result!.summary).toBe("done with DONE.md");
      expect(result!.taskNumber).toBe(1);

      // PLAN.md should have item 1 checked
      const updatedPlan = fs.readFileSync(path.join(dir, "PLAN.md"), "utf8");
      expect(updatedPlan).toContain("- [x] item 1");

      const commitMessage = (await tryGit(dir, "log", "-1", "--format=%s")).out;
      expect(commitMessage).toBe("ralph: task 1 — done with DONE.md");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns result even when all items are already checked", async () => {
    const dir = fs.mkdtempSync("/tmp/ralph-test-");
    try {
      await tryGit(dir, "init");
      await tryGit(dir, "config", "user.email", "test@test.com");
      await tryGit(dir, "config", "user.name", "Test");
      const planMd = "## Tasks\n- [x] item 1\n";
      fs.writeFileSync(path.join(dir, "PLAN.md"), planMd);
      await tryGit(dir, "add", "-A");
      await tryGit(dir, "commit", "-m", "initial");

      const initialHead = (await tryGit(dir, "rev-parse", "HEAD")).out;

      fs.writeFileSync(path.join(dir, "DONE"), "all done");

      const result = await performDoneBookkeeping({
        ralphDir: dir,
        worktreePath: dir,
        planPath: path.join(dir, "PLAN.md"),
      });

      // Should still return the result with summary, taskNumber=0 (no unchecked item)
      expect(result).not.toBeNull();
      expect(result!.summary).toBe("all done");
      expect(result!.taskNumber).toBe(0);

      // No new commit since nothing to mark
      const newHead = (await tryGit(dir, "rev-parse", "HEAD")).out;
      expect(newHead).toBe(initialHead);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses only the first line of DONE as summary", async () => {
    const dir = fs.mkdtempSync("/tmp/ralph-test-");
    try {
      await tryGit(dir, "init");
      await tryGit(dir, "config", "user.email", "test@test.com");
      await tryGit(dir, "config", "user.name", "Test");
      const planMd = "## Tasks\n- [ ] item 1\n";
      fs.writeFileSync(path.join(dir, "PLAN.md"), planMd);
      await tryGit(dir, "add", "-A");
      await tryGit(dir, "commit", "-m", "initial");

      // Multi-line DONE file
      fs.writeFileSync(dir + "/DONE", "TLDR: implemented the thing\n- bullet 1\n- bullet 2\n");

      const result = await performDoneBookkeeping({
        ralphDir: dir,
        worktreePath: dir,
        planPath: path.join(dir, "PLAN.md"),
      });

      expect(result).not.toBeNull();
      expect(result!.summary).toBe("TLDR: implemented the thing");

      const commitMessage = (await tryGit(dir, "log", "-1", "--format=%s")).out;
      expect(commitMessage).toBe("ralph: task 1 — TLDR: implemented the thing");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("integration-level signal flow (stall detection via buildProgressState before/after)", () => {
  it("buildProgressState returns the same value when called twice with no changes (stall would be detected)", async () => {
    const dir = fs.mkdtempSync("/tmp/ralph-test-");
    try {
      await tryGit(dir, "init");
      await tryGit(dir, "config", "user.email", "test@test.com");
      await tryGit(dir, "config", "user.name", "Test");
      const planMd = "## Tasks\n- [ ] item 1\n- [ ] item 2\n";
      fs.writeFileSync(path.join(dir, "PLAN.md"), planMd);
      await tryGit(dir, "add", "-A");
      await tryGit(dir, "commit", "-m", "initial");

      const planPath = path.join(dir, "PLAN.md");

      const before = await buildProgressState(dir, planPath);
      const after = await buildProgressState(dir, planPath);

      // No changes → identical strings → stall detection would fire
      expect(before).toBe(after);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("buildProgressState detects a committed change as progress", async () => {
    const dir = fs.mkdtempSync("/tmp/ralph-test-");
    try {
      await tryGit(dir, "init");
      await tryGit(dir, "config", "user.email", "test@test.com");
      await tryGit(dir, "config", "user.name", "Test");
      const planMd = "## Tasks\n- [ ] item 1\n";
      fs.writeFileSync(path.join(dir, "PLAN.md"), planMd);
      await tryGit(dir, "add", "-A");
      await tryGit(dir, "commit", "-m", "initial");

      const planPath = path.join(dir, "PLAN.md");

      const before = await buildProgressState(dir, planPath);

      // Make a committed change (new file, commit it)
      fs.writeFileSync(path.join(dir, "newfile.txt"), "content");
      await tryGit(dir, "add", "-A");
      await tryGit(dir, "commit", "-m", "progress");

      const after = await buildProgressState(dir, planPath);

      // HEAD changed → different progress state → stall reset
      expect(before).not.toBe(after);
      expect(after).toContain((await tryGit(dir, "rev-parse", "HEAD")).out);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("buildProgressState detects uncommitted ITERATION_DONE as progress", async () => {
    const dir = fs.mkdtempSync("/tmp/ralph-test-");
    try {
      await tryGit(dir, "init");
      await tryGit(dir, "config", "user.email", "test@test.com");
      await tryGit(dir, "config", "user.name", "Test");
      const planMd = "## Tasks\n- [ ] item 1\n- [ ] item 2\n";
      fs.writeFileSync(path.join(dir, "PLAN.md"), planMd);
      await tryGit(dir, "add", "-A");
      await tryGit(dir, "commit", "-m", "initial");

      const planPath = path.join(dir, "PLAN.md");

      const before = await buildProgressState(dir, planPath);

      // Write ITERATION_DONE (what the agent does in bookkeeping mode)
      fs.writeFileSync(path.join(dir, "ITERATION_DONE"), "implemented item 1");

      const after = await buildProgressState(dir, planPath);

      // Dirty worktree → different progress state → stall reset
      expect(before).not.toBe(after);
      expect(after).toContain("ITERATION_DONE");

      // Now verify that after committing, the state changes again (HEAD moves)
      const afterCommitBefore = await buildProgressState(dir, planPath);
      await tryGit(dir, "add", "-A");
      await tryGit(dir, "commit", "-m", "ralph: task 1 — implemented item 1");
      const afterCommitAfter = await buildProgressState(dir, planPath);

      // Committed state should differ from dirty state (HEAD changed + worktree clean)
      expect(afterCommitAfter).not.toBe(afterCommitBefore);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("three consecutive identical progressState values would trigger a stall (simulated)", async () => {
    const dir = fs.mkdtempSync("/tmp/ralph-test-");
    try {
      await tryGit(dir, "init");
      await tryGit(dir, "config", "user.email", "test@test.com");
      await tryGit(dir, "config", "user.name", "Test");
      const planMd = "## Tasks\n- [ ] item 1\n";
      fs.writeFileSync(path.join(dir, "PLAN.md"), planMd);
      await tryGit(dir, "add", "-A");
      await tryGit(dir, "commit", "-m", "initial");

      const planPath = path.join(dir, "PLAN.md");

      // Simulate three iterations with no progress
      let consecutiveStalls = 0;
      const maxStalls = 3;

      for (let i = 0; i < 5; i++) {
        const before = await buildProgressState(dir, planPath);
        // no change happens
        const after = await buildProgressState(dir, planPath);

        if (after === before) {
          consecutiveStalls++;
        } else {
          consecutiveStalls = 0;
        }

        if (consecutiveStalls >= maxStalls) {
          // Stall detected! This should happen on the 3rd iteration.
          expect(i).toBe(2); // 0-indexed: 0, 1, 2 → stall on iteration 3
          break;
        }
      }

      expect(consecutiveStalls).toBeGreaterThanOrEqual(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("commit after ITERATION_DONE resets stall counter (progress detected via dirty + commit)", async () => {
    const dir = fs.mkdtempSync("/tmp/ralph-test-");
    try {
      await tryGit(dir, "init");
      await tryGit(dir, "config", "user.email", "test@test.com");
      await tryGit(dir, "config", "user.name", "Test");
      const planMd = "## Tasks\n- [ ] item 1\n- [ ] item 2\n";
      fs.writeFileSync(path.join(dir, "PLAN.md"), planMd);
      await tryGit(dir, "add", "-A");
      await tryGit(dir, "commit", "-m", "initial");

      const planPath = path.join(dir, "PLAN.md");

      // First iteration: no progress (stall count would go to 1)
      const s1_before = await buildProgressState(dir, planPath);
      const s1_after = await buildProgressState(dir, planPath);
      expect(s1_after).toBe(s1_before);

      // Second iteration: agent writes ITERATION_DONE (progress!)
      fs.writeFileSync(path.join(dir, "ITERATION_DONE"), "implemented item 1");
      const s2_before = await buildProgressState(dir, planPath);
      const s2_after = await buildProgressState(dir, planPath);
      // Both measure the same dirty state → still equal (but different from s1)
      expect(s2_after).toBe(s2_before);
      // But s2 differs from s1 → progress detected
      expect(s2_before).not.toBe(s1_before);

      // Third iteration: orchestrator has committed (HEAD moves, worktree clean)
      await tryGit(dir, "add", "-A");
      await tryGit(dir, "commit", "-m", "ralph: task 1 — implemented item 1");
      const s3_before = await buildProgressState(dir, planPath);
      const s3_after = await buildProgressState(dir, planPath);
      expect(s3_after).toBe(s3_before);
      expect(s3_before).not.toBe(s2_before);

      // Now simulate the stall-detection logic: no progress for 3 iterations
      let consecutiveStalls = 0;
      const states = [s1_before, s2_before, s3_before];
      for (let i = 1; i < states.length; i++) {
        if (states[i] === states[i - 1]) {
          consecutiveStalls++;
        } else {
          consecutiveStalls = 0;
        }
      }
      // Each state changed → stalls never reached 3
      expect(consecutiveStalls).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
describe("phantom-completion guard", () => {
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

  it("hasIterationWorkProduct ignores the signal file but sees real edits", async () => {
    const dir = await initRepo();
    try {
      const pre = await captureIterationState(dir);

      // Only the signal file appears → no work product
      fs.writeFileSync(path.join(dir, "ITERATION_DONE"), "did the thing");
      expect(await hasIterationWorkProduct(dir, pre)).toBe(false);

      // A real edit appears → work product
      fs.writeFileSync(path.join(dir, "feature.ts"), "export const x = 1;");
      expect(await hasIterationWorkProduct(dir, pre)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hasIterationWorkProduct sees a new commit even with a clean worktree", async () => {
    const dir = await initRepo();
    try {
      const pre = await captureIterationState(dir);
      fs.writeFileSync(path.join(dir, "feature.ts"), "export const x = 1;");
      await tryGit(dir, "add", "-A");
      await tryGit(dir, "commit", "-m", "agent committed despite the rules");
      expect(await hasIterationWorkProduct(dir, pre)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a phantom completion: signal removed, checklist NOT advanced, no commit", async () => {
    const dir = await initRepo();
    try {
      const pre = await captureIterationState(dir);
      fs.writeFileSync(path.join(dir, "ITERATION_DONE"), "claims item 1 is done");

      const result = await performIterationBookkeeping({
        ralphDir: dir,
        worktreePath: dir,
        planPath: path.join(dir, "PLAN.md"),
        pre,
      });

      expect(result).toEqual({
        advanced: false,
        phantom: true,
        taskNumber: 1,
        summary: "claims item 1 is done",
      });
      // Signal removed so the next iteration starts clean
      expect(fs.existsSync(path.join(dir, "ITERATION_DONE"))).toBe(false);
      // Checklist untouched
      expect(fs.readFileSync(path.join(dir, "PLAN.md"), "utf8")).toContain("- [ ] item 1");
      // No commit made
      expect((await tryGit(dir, "log", "--oneline")).out.split("\n").filter(Boolean).length).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("advances normally when the iteration produced real edits", async () => {
    const dir = await initRepo();
    try {
      const pre = await captureIterationState(dir);
      fs.writeFileSync(path.join(dir, "feature.ts"), "export const x = 1;");
      fs.writeFileSync(path.join(dir, "ITERATION_DONE"), "implemented item 1");

      const result = await performIterationBookkeeping({
        ralphDir: dir,
        worktreePath: dir,
        planPath: path.join(dir, "PLAN.md"),
        pre,
      });

      expect(result).not.toBeNull();
      expect(result!.advanced).toBe(true);
      expect(fs.readFileSync(path.join(dir, "PLAN.md"), "utf8")).toContain("- [x] item 1");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps legacy behavior when no pre snapshot is passed", async () => {
    const dir = await initRepo();
    try {
      fs.writeFileSync(path.join(dir, "ITERATION_DONE"), "no snapshot given");

      const result = await performIterationBookkeeping({
        ralphDir: dir,
        worktreePath: dir,
        planPath: path.join(dir, "PLAN.md"),
      });

      expect(result).not.toBeNull();
      expect(result!.advanced).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

