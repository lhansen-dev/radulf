import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { and, desc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

const execFileAsync = promisify(execFile);

// Direct unit tests for EvaluationService — the orchestrator-level lifecycle
// tests exercise the happy paths (approve, revise-with-zero-priors,
// revise-with-three-priors); this file drives MAX_EVALUATOR_REVISIONS to its
// exact boundary instead: revision #2 must still re-plan, revision #3 must
// trip the cap. See PLAN.md Phase 11.

const mocks = vi.hoisted(() => ({
  runHarness: vi.fn(),
  tryGit: vi.fn(),
  offRunBranchReason: vi.fn(),
  // Mutable so the Phase 18.1 regression test below can flip sandboxing on
  // for just that one test (it needs a real git repo + real srtConfig build
  // to reproduce the FK-ordering bug) without disturbing every other test in
  // this file, which deliberately keeps sandboxing off — see the comment on
  // `sandboxEnabled` below.
  settings: {
    evaluatorModel: "evaluator-model",
    evaluatorTimeoutMinutes: 10,
    evaluatorPromptTemplate: "Evaluate {{TITLE}} from {{BASE_BRANCH}}\n{{DESCRIPTION}}\n{{CRITERIA}}",
    // Lifecycle tests use plain mkdtemp worktrees, not real git repos — same
    // reasoning applies here: sandboxEnabled:false keeps createRunSandbox
    // from resolving a real git-common-dir against a fake worktree.
    sandboxEnabled: false,
    sandboxWeakerIsolationForGoTls: false,
    // The workspace-wide auto-approve override. Off for every test but the
    // ones that flip it, so the card's own flag stays the only grant.
    autoApprove: false,
  },
}));

vi.mock("./harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./harness")>()),
  runHarness: mocks.runHarness,
}));
vi.mock("./git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./git")>()),
  tryGit: mocks.tryGit,
  offRunBranchReason: mocks.offRunBranchReason,
}));
vi.mock("./settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settings")>()),
  getSettings: () => testSettings(mocks.settings),
}));

const testDataDir = setupTestDataDir("radulf-evaluationService-");
const { testSettings } = await import("@/testUtils/testSettings");

const { db, cards, events, plans, runs, repos, now } = await import("@/db");
const { EvaluationService, renderEvaluatorPrompt } = await import("./evaluationService");

function seedRepo() {
  db.insert(repos)
    .values({
      id: "repo-1",
      name: "Repo",
      path: path.join(testDataDir, "repo"),
      defaultBranch: "main",
      createdAt: now(),
    })
    .run();
}

function seedCard(id: string, autoApprove: 0 | 1 = 0) {
  db.insert(cards)
    .values({
      id,
      repoId: "repo-1",
      title: `Card ${id}`,
      description: "Evaluation service test card",
      status: "evaluating",
      autoApprove,
      position: 1,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

function seedPlan(cardId: string, version = 1) {
  const id = `plan-${cardId}-v${version}`;
  db.insert(plans)
    .values({
      id,
      cardId,
      version,
      planMd: "## Tasks\n- [ ] implement the thing\n",
      promptMd: "Implement the thing.",
      acceptanceCriteria: "The thing is implemented.",
      createdAt: now(),
    })
    .run();
  return id;
}

/** The loop run being evaluated — a real worktree dir on disk (fs ops in
 * evaluationService.ts read/write `.ralph/*` there), but the FK-required
 * `runs` row too, since deps.latestWorktreeRun must return a real Run. */
function seedLoopRun(cardId: string, planId: string) {
  const worktreePath = fs.mkdtempSync(path.join(testDataDir, "worktree-"));
  fs.mkdirSync(path.join(worktreePath, ".ralph"), { recursive: true });
  const id = `loop-${cardId}`;
  db.insert(runs)
    .values({
      id,
      cardId,
      planId,
      kind: "loop",
      status: "completed",
      worktreePath,
      branch: `ralph/${id}`,
      baseBranch: "main",
      startedAt: now(),
      endedAt: now(),
    })
    .run();
  return { id, worktreePath };
}

/** Like `seedLoopRun`, but the worktree is a real git repo — needed to drive
 * `createRunSandbox`'s real `srtConfig` path (`resolveGitCommonDir` shells
 * out to `git rev-parse`), which is what the Phase 18.1 regression test below
 * needs to actually build a real `runs.weakerIsolationEnabled`-triggering
 * sandbox context rather than the short-circuited `sandboxEnabled: false`
 * path every other test in this file uses. */
async function seedLoopRunGitRepo(cardId: string, planId: string) {
  const worktreePath = fs.mkdtempSync(path.join(testDataDir, "worktree-git-"));
  await execFileAsync("git", ["-C", worktreePath, "init"]);
  await execFileAsync("git", ["-C", worktreePath, "config", "user.email", "t@t.com"]);
  await execFileAsync("git", ["-C", worktreePath, "config", "user.name", "T"]);
  fs.writeFileSync(path.join(worktreePath, "f"), "x");
  await execFileAsync("git", ["-C", worktreePath, "add", "."]);
  await execFileAsync("git", ["-C", worktreePath, "commit", "-m", "init"]);
  fs.mkdirSync(path.join(worktreePath, ".ralph"), { recursive: true });
  const id = `loop-${cardId}`;
  db.insert(runs)
    .values({
      id,
      cardId,
      planId,
      kind: "loop",
      status: "completed",
      worktreePath,
      branch: `ralph/${id}`,
      baseBranch: "main",
      startedAt: now(),
      endedAt: now(),
    })
    .run();
  return { id, worktreePath };
}

/** Seed `count` completed evaluate runs with exitReason "revise" — exactly
 * what evaluationService.ts's priorRevisions query counts. */
function seedPriorRevisions(cardId: string, count: number) {
  for (let i = 0; i < count; i++) {
    db.insert(runs)
      .values({
        id: `prior-revise-${cardId}-${i}`,
        cardId,
        kind: "evaluate",
        status: "completed",
        worktreePath: "/tmp/irrelevant",
        branch: "irrelevant",
        startedAt: now(),
        exitReason: "revise",
      })
      .run();
  }
}

/** Queue runHarness to write EVALUATION.md as a side effect, mirroring what
 * the real evaluator harness does. Must be a mock side effect, not written
 * ahead of the call — runEvaluator unconditionally clears any pre-existing
 * EVALUATION.md at the top of the run (clearEvaluationArtifact) so a stale
 * verdict from an earlier attempt is never read as this run's output. */
function mockEvaluationVerdict(content: string) {
  mocks.runHarness.mockImplementationOnce(async ({ cwd }: { cwd: string }) => {
    fs.writeFileSync(path.join(cwd, ".ralph", "EVALUATION.md"), content);
    return { timedOut: false, error: "", code: 0, lastText: "done" };
  });
}

function makeDeps() {
  return {
    getCard: (id: string) => db.select().from(cards).where(eq(cards.id, id)).get(),
    latestPlan: (id: string) =>
      db.select().from(plans).where(eq(plans.cardId, id)).orderBy(desc(plans.version)).limit(1).get(),
    latestWorktreeRun: (id: string) =>
      db
        .select()
        .from(runs)
        .where(and(eq(runs.cardId, id), eq(runs.kind, "loop")))
        .orderBy(desc(runs.startedAt))
        .limit(1)
        .get(),
    moveCard: vi.fn(() => true),
    finishRun: vi.fn(() => true),
    registerController: vi.fn(),
    releaseController: vi.fn(),
    pump: vi.fn(),
    replan: vi.fn(),
    approveReview: vi.fn(async () => ({ ok: true })),
  };
}

describe("renderEvaluatorPrompt", () => {
  it("fills every placeholder", () => {
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

describe("EvaluationService.runEvaluator", () => {
  beforeEach(() => {
    db.delete(events).run();
    db.delete(runs).run();
    db.delete(plans).run();
    db.delete(cards).run();
    db.delete(repos).run();
    vi.clearAllMocks();
    mocks.runHarness.mockResolvedValue({ timedOut: false, error: "", code: 0, lastText: "done" });
    mocks.tryGit.mockResolvedValue({ ok: true, out: "" });
    mocks.offRunBranchReason.mockResolvedValue(null);
    mocks.settings.sandboxEnabled = false;
    mocks.settings.sandboxWeakerIsolationForGoTls = false;
    mocks.settings.autoApprove = false;
    mocks.settings.evaluatorTimeoutMinutes = 10;
    seedRepo();
  });

  it("approves and advances the card to review", async () => {
    mocks.settings.evaluatorTimeoutMinutes = 17;
    seedCard("card-approve");
    const planId = seedPlan("card-approve");
    seedLoopRun("card-approve", planId);
    mockEvaluationVerdict("VERDICT: approve\n\nLooks solid.");
    const deps = makeDeps();

    await new EvaluationService(deps).runEvaluator("card-approve");

    expect(deps.moveCard).toHaveBeenCalledWith("card-approve", "evaluating", "review", "evaluator approved");
    expect(deps.finishRun).toHaveBeenCalledWith(expect.any(String), "completed", "approve", expect.any(Object));
    expect(mocks.runHarness).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 17 * 60 * 1000 }),
    );
    expect(deps.replan).not.toHaveBeenCalled();
    expect(deps.approveReview).not.toHaveBeenCalled();
  });

  it("starts no harness for a card that left evaluating before its run row existed", async () => {
    seedCard("card-left-early");
    const planId = seedPlan("card-left-early");
    seedLoopRun("card-left-early", planId);
    // A cancel that landed during the awaited sandbox and integrity setup:
    // the card is already back in Backlog when the run row is written.
    db.update(cards).set({ status: "backlog" }).where(eq(cards.id, "card-left-early")).run();
    const deps = makeDeps();

    await new EvaluationService(deps).runEvaluator("card-left-early");

    expect(mocks.runHarness).not.toHaveBeenCalled();
    expect(deps.finishRun).toHaveBeenCalledWith(
      expect.any(String),
      "cancelled",
      "card left evaluating before the run started",
    );
    expect(deps.moveCard).not.toHaveBeenCalled();
    expect(deps.pump).toHaveBeenCalled();
  });

  it("rejects the verdict when the evaluator moved the worktree off the run branch", async () => {
    seedCard("card-off-branch");
    const planId = seedPlan("card-off-branch");
    seedLoopRun("card-off-branch", planId);
    mockEvaluationVerdict("VERDICT: approve\n\nLooks solid.");
    const reason = "worktree left its run branch: on main, expected ralph/run";
    mocks.offRunBranchReason.mockResolvedValue(reason);
    const deps = makeDeps();

    await new EvaluationService(deps).runEvaluator("card-off-branch");

    expect(deps.finishRun).toHaveBeenCalledWith(expect.any(String), "failed", reason, expect.any(Object));
    expect(deps.moveCard).toHaveBeenCalledWith("card-off-branch", "evaluating", "needs_attention", reason);
    expect(mocks.tryGit.mock.calls.some(([, cmd]) => cmd === "commit")).toBe(false);
  });

  it("accepts approve-time doc edits even when git's first status line arrives trimmed", async () => {
    seedCard("card-doc-edits");
    const planId = seedPlan("card-doc-edits");
    seedLoopRun("card-doc-edits", planId);
    mockEvaluationVerdict("VERDICT: approve\n\nDocs refreshed.");
    // tryGit trims stdout, so the first porcelain line loses the leading space
    // of its unstaged-change marker. Before the harness the tree is clean;
    // after it two docs changed. Every other git call answers as before.
    let statusCalls = 0;
    mocks.tryGit.mockImplementation(async (_cwd: string, ...args: string[]) => {
      if (args[0] === "status") {
        statusCalls += 1;
        return { ok: true, out: statusCalls === 1 ? "" : "M docs/ARCHITECTURE.md\n M docs/TROUBLESHOOTING.md" };
      }
      return { ok: true, out: "" };
    });
    const deps = makeDeps();

    await new EvaluationService(deps).runEvaluator("card-doc-edits");

    expect(deps.moveCard).toHaveBeenCalledWith("card-doc-edits", "evaluating", "review", "evaluator approved");
    expect(deps.finishRun).toHaveBeenCalledWith(expect.any(String), "completed", "approve", expect.any(Object));
  });

  // Spec 20: the evaluator holds one of its repo's pipeline slots, so it owes
  // the queue a pump when it lets go. It was the only stage that never did,
  // which left ready cards parked behind a slot nothing was using.
  it.each([
    ["a verdict", "VERDICT: approve\n\nLooks solid."],
    ["no usable verdict", "I could not tell."],
  ])("pumps the queue when the evaluation ends with %s", async (_label, report) => {
    seedCard("card-pump");
    const planId = seedPlan("card-pump");
    seedLoopRun("card-pump", planId);
    mockEvaluationVerdict(report);
    const deps = makeDeps();

    await new EvaluationService(deps).runEvaluator("card-pump");

    expect(deps.pump).toHaveBeenCalled();
  });

  // Auto-approve is granted by the card's own flag OR the workspace-wide
  // setting, and the resulting event has to say which — the card row alone
  // can't explain a past auto-merge once the global has been toggled again.
  describe("auto-approve", () => {
    function autoApproveSource(cardId: string): string | undefined {
      const event = db
        .select()
        .from(events)
        .where(and(eq(events.cardId, cardId), eq(events.type, "card.auto_approved")))
        .get();
      return event ? (JSON.parse(event.payload) as { source?: string }).source : undefined;
    }

    async function evaluate(cardId: string) {
      const planId = seedPlan(cardId);
      seedLoopRun(cardId, planId);
      mockEvaluationVerdict("VERDICT: approve\n\nLooks solid.");
      const deps = makeDeps();
      await new EvaluationService(deps).runEvaluator(cardId);
      return deps;
    }

    it("auto-approves on the card's own flag while the global setting is off", async () => {
      seedCard("card-flag", 1);

      const deps = await evaluate("card-flag");

      expect(deps.approveReview).toHaveBeenCalledTimes(1);
      expect(autoApproveSource("card-flag")).toBe("card");
    });

    it("auto-approves a card whose own flag is off when the global setting is on", async () => {
      mocks.settings.autoApprove = true;
      seedCard("card-global", 0);

      const deps = await evaluate("card-global");

      expect(deps.approveReview).toHaveBeenCalledTimes(1);
      expect(autoApproveSource("card-global")).toBe("global");
    });

    it("attributes to the card when both grant it", async () => {
      mocks.settings.autoApprove = true;
      seedCard("card-both", 1);

      await evaluate("card-both");

      expect(autoApproveSource("card-both")).toBe("card");
    });

    it("waits for a human when neither grants it", async () => {
      seedCard("card-neither", 0);

      const deps = await evaluate("card-neither");

      expect(deps.approveReview).not.toHaveBeenCalled();
      expect(autoApproveSource("card-neither")).toBeUndefined();
    });
  });

  it("revises normally when exactly one prior revision exists — below MAX_EVALUATOR_REVISIONS (2)", async () => {
    seedCard("card-revise-below-cap");
    const planId = seedPlan("card-revise-below-cap");
    seedLoopRun("card-revise-below-cap", planId);
    seedPriorRevisions("card-revise-below-cap", 1);
    mockEvaluationVerdict("VERDICT: revise\n\nStill missing tests.");
    const deps = makeDeps();

    await new EvaluationService(deps).runEvaluator("card-revise-below-cap");

    expect(deps.moveCard).toHaveBeenCalledWith(
      "card-revise-below-cap",
      "evaluating",
      "planning",
      "evaluator requested changes — re-planning",
    );
    expect(deps.finishRun).toHaveBeenCalledWith(expect.any(String), "completed", "revise", expect.any(Object));
    // Re-planned rather than escalated to human review; the planner, not the
    // evaluator, writes the next plan version.
    expect(deps.replan).toHaveBeenCalledWith("card-revise-below-cap");
    expect(
      db.select().from(plans).where(eq(plans.cardId, "card-revise-below-cap")).all(),
    ).toHaveLength(1);
    // finishRun is mocked, so this run is the one evaluate row still running.
    const evaluateRun = db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.cardId, "card-revise-below-cap"),
          eq(runs.kind, "evaluate"),
          eq(runs.status, "running"),
        ),
      )
      .get();
    expect(evaluateRun?.feedback).toBe("Still missing tests.");
  });

  it("trips MAX_EVALUATOR_REVISIONS exactly at 2 prior revisions — not 1 before, not 3 after", async () => {
    seedCard("card-revise-at-cap");
    const planId = seedPlan("card-revise-at-cap");
    seedLoopRun("card-revise-at-cap", planId);
    seedPriorRevisions("card-revise-at-cap", 2);
    mockEvaluationVerdict("VERDICT: revise\n\nStill missing tests.");
    const deps = makeDeps();

    await new EvaluationService(deps).runEvaluator("card-revise-at-cap");

    expect(deps.moveCard).toHaveBeenCalledWith(
      "card-revise-at-cap",
      "evaluating",
      "review",
      "evaluator revision limit — escalated to human review",
    );
    expect(deps.finishRun).toHaveBeenCalledWith(
      expect.any(String),
      "completed",
      "revise — revision limit reached",
      expect.any(Object),
    );
    // The capped path never re-plans.
    expect(deps.replan).not.toHaveBeenCalled();

    // No new plan version — the card escalates instead of going round again.
    const versions = db
      .select()
      .from(plans)
      .where(eq(plans.cardId, "card-revise-at-cap"))
      .all()
      .map((p) => p.version);
    expect(versions).toEqual([1]);
  });

  // PLAN.md Phase 18.1: createRunSandbox used to emit "sandbox.weaker_isolation_enabled"
  // itself, before its caller's `runs` row existed — a real FK violation
  // (events.run_id -> runs.id, Phase 8) that crashed every evaluate run
  // whenever sandboxWeakerIsolationForGoTls was on. This is a real, unmocked
  // "@/db" (foreign_keys = ON, src/db/index.ts:32), so the old ordering bug
  // would fail this test with SQLITE_CONSTRAINT_FOREIGNKEY rather than a
  // wholesale-mocked assertion papering over it.
  it("PLAN.md Phase 18.1 regression: does not violate events.run_id FK when sandboxWeakerIsolationForGoTls is on", async () => {
    mocks.settings.sandboxEnabled = true;
    mocks.settings.sandboxWeakerIsolationForGoTls = true;
    seedCard("card-weaker-iso");
    const planId = seedPlan("card-weaker-iso");
    await seedLoopRunGitRepo("card-weaker-iso", planId);
    mockEvaluationVerdict("VERDICT: approve\n\nLooks solid.");
    const deps = makeDeps();

    // Would throw (SQLITE_CONSTRAINT_FOREIGNKEY) under the pre-fix ordering.
    await new EvaluationService(deps).runEvaluator("card-weaker-iso");

    const weakerEvents = db
      .select()
      .from(events)
      .where(eq(events.type, "sandbox.weaker_isolation_enabled"))
      .all();
    expect(weakerEvents).toHaveLength(1);
    expect(weakerEvents[0].cardId).toBe("card-weaker-iso");
    expect(weakerEvents[0].runId).toEqual(expect.any(String));

    // The runs row the event references must actually exist — proves the
    // insert really did land before the event, not just that no error was
    // thrown (a swallowed error could also produce an empty result here).
    const referencedRun = db
      .select()
      .from(runs)
      .where(eq(runs.id, weakerEvents[0].runId!))
      .get();
    expect(referencedRun).toBeDefined();
  });
});

// Spec 26: a retry inherits the attempt it retries.
const { runTranscriptDir } = await import("./retention");

describe("EvaluationService.runEvaluator — retries inherit the failed attempt (spec 26)", () => {
  beforeEach(() => {
    db.delete(events).run();
    db.delete(runs).run();
    db.delete(plans).run();
    db.delete(cards).run();
    db.delete(repos).run();
    vi.clearAllMocks();
    mocks.runHarness.mockResolvedValue({ timedOut: false, error: "", code: 0, lastText: "done" });
    mocks.tryGit.mockResolvedValue({ ok: true, out: "" });
    mocks.offRunBranchReason.mockResolvedValue(null);
    mocks.settings.sandboxEnabled = false;
    mocks.settings.sandboxWeakerIsolationForGoTls = false;
    mocks.settings.autoApprove = false;
    mocks.settings.evaluatorTimeoutMinutes = 10;
    seedRepo();
  });

  /** A timed-out evaluate attempt on the loop run's worktree, started after it. */
  function seedFailedEvaluate(cardId: string, worktreePath: string) {
    const id = `ev-failed-${cardId}`;
    const started = new Date(Date.now() + 60_000);
    db.insert(runs)
      .values({
        id,
        cardId,
        kind: "evaluate",
        status: "timeout",
        exitReason: "evaluation timed out",
        worktreePath,
        branch: `ralph/loop-${cardId}`,
        baseBranch: "main",
        startedAt: started.toISOString(),
        endedAt: new Date(started.getTime() + 10 * 60_000).toISOString(),
      })
      .run();
    return id;
  }

  const notesPath = (worktreePath: string) => path.join(worktreePath, ".ralph", "EVALUATION-NOTES.md");

  it("forwards the timed-out attempt's digest and notes into the retry, and keeps the notes file", async () => {
    seedCard("card-retry");
    const planId = seedPlan("card-retry");
    const { worktreePath } = seedLoopRun("card-retry", planId);
    const prevId = seedFailedEvaluate("card-retry", worktreePath);
    const dir = runTranscriptDir(prevId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "evaluate.jsonl"),
      [
        { t: "tool", name: "bash", input: { command: "make check-split" } },
        { t: "raw", event: { type: "tool_execution_end", result: { content: [{ type: "text", text: "3 passed" }] }, isError: false } },
        { t: "text", role: "assistant", content: "The suite is the problem, not the change." },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    fs.writeFileSync(notesPath(worktreePath), "- check-split: PASS\n");
    mockEvaluationVerdict("VERDICT: approve\n\nFine.");
    const deps = makeDeps();

    await new EvaluationService(deps).runEvaluator("card-retry");

    const prompt = mocks.runHarness.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("PREVIOUS ATTEMPT OF THIS STAGE");
    expect(prompt).toContain("ended with: evaluation timed out after 10 minutes.");
    expect(prompt).toContain("1. bash: make check-split\n     3 passed");
    expect(prompt).toContain("The suite is the problem, not the change.");
    expect(prompt).toContain("- check-split: PASS");
    expect(prompt).toContain("RUNNING NOTES");
    expect(prompt).toContain("ATTEMPT BUDGET");
    expect(prompt).toContain("hard budget is 10 minutes");
    expect(fs.readFileSync(notesPath(worktreePath), "utf8")).toBe("- check-split: PASS\n");
    const forwarded = db.select().from(events).where(eq(events.type, "attempt.forwarded")).all();
    expect(forwarded).toHaveLength(1);
    expect(JSON.parse(forwarded[0].payload)).toMatchObject({ kind: "evaluate", previousRunId: prevId, toolCalls: 1 });
    expect(deps.moveCard).toHaveBeenCalledWith("card-retry", "evaluating", "review", "evaluator approved");
  });

  it("starts a fresh cycle after a loop run with no notes and no previous-attempt section", async () => {
    seedCard("card-fresh");
    const planId = seedPlan("card-fresh");
    const { worktreePath } = seedLoopRun("card-fresh", planId);
    fs.writeFileSync(notesPath(worktreePath), "stale notes from the last cycle\n");
    mockEvaluationVerdict("VERDICT: approve\n\nFine.");

    await new EvaluationService(makeDeps()).runEvaluator("card-fresh");

    const prompt = mocks.runHarness.mock.calls[0][0].prompt as string;
    expect(prompt).not.toContain("PREVIOUS ATTEMPT OF THIS STAGE");
    expect(prompt).not.toContain("stale notes");
    expect(prompt).toContain("RUNNING NOTES");
    expect(prompt).toContain("ATTEMPT BUDGET");
    expect(fs.existsSync(notesPath(worktreePath))).toBe(false);
    expect(db.select().from(events).where(eq(events.type, "attempt.forwarded")).all()).toHaveLength(0);
  });

  it("honours a complete verdict the attempt wrote before the watchdog killed it", async () => {
    seedCard("card-late");
    const planId = seedPlan("card-late");
    seedLoopRun("card-late", planId);
    mocks.runHarness.mockImplementationOnce(async ({ cwd }: { cwd: string }) => {
      fs.writeFileSync(path.join(cwd, ".ralph", "EVALUATION.md"), "VERDICT: approve\n\nDone just in time.\n");
      return { timedOut: true, stalled: false, error: "stopReason: aborted", code: 1, lastText: "" };
    });
    const deps = makeDeps();

    await new EvaluationService(deps).runEvaluator("card-late");

    expect(deps.moveCard).toHaveBeenCalledWith("card-late", "evaluating", "review", "evaluator approved");
    expect(deps.finishRun).toHaveBeenCalledWith(expect.any(String), "completed", "approve", expect.any(Object));
    const recovered = db.select().from(events).where(eq(events.type, "evaluation.recovered_after_timeout")).all();
    expect(recovered).toHaveLength(1);
    expect(JSON.parse(recovered[0].payload)).toEqual({ cause: "timeout" });
  });

  it("still fails a timeout that left no usable verdict behind", async () => {
    seedCard("card-dead");
    const planId = seedPlan("card-dead");
    seedLoopRun("card-dead", planId);
    mocks.runHarness.mockResolvedValueOnce({ timedOut: true, stalled: false, error: "", code: 1, lastText: "" });
    const deps = makeDeps();

    await new EvaluationService(deps).runEvaluator("card-dead");

    expect(deps.finishRun).toHaveBeenCalledWith(expect.any(String), "timeout", "evaluation timed out", expect.any(Object));
    expect(deps.moveCard).toHaveBeenCalledWith("card-dead", "evaluating", "needs_attention", "evaluation timed out");
    expect(db.select().from(events).where(eq(events.type, "evaluation.recovered_after_timeout")).all()).toHaveLength(0);
  });
});

// Spec 27: the repository gate, run by the orchestrator before the evaluator.
describe("EvaluationService.runEvaluator — the repository gate (spec 27)", () => {
  beforeEach(() => {
    db.delete(events).run();
    db.delete(runs).run();
    db.delete(plans).run();
    db.delete(cards).run();
    db.delete(repos).run();
    vi.clearAllMocks();
    mocks.runHarness.mockResolvedValue({ timedOut: false, error: "", code: 0, lastText: "done" });
    mocks.tryGit.mockResolvedValue({ ok: true, out: "" });
    mocks.offRunBranchReason.mockResolvedValue(null);
    mocks.settings.sandboxEnabled = false;
    mocks.settings.sandboxWeakerIsolationForGoTls = false;
    mocks.settings.autoApprove = false;
    mocks.settings.evaluatorTimeoutMinutes = 10;
    seedRepo();
  });

  const setGate = (command: string | null) => db.update(repos).set({ gateCommand: command }).where(eq(repos.id, "repo-1")).run();
  const gatePath = (worktreePath: string) => path.join(worktreePath, ".ralph", "GATE.md");
  const eventsOfType = (type: string) => db.select().from(events).where(eq(events.type, type)).all();

  /** A timed-out evaluate attempt on the loop run's worktree, started after it. */
  function seedFailedEvaluate(cardId: string, worktreePath: string) {
    const started = new Date(Date.now() + 60_000);
    db.insert(runs)
      .values({
        id: `ev-failed-${cardId}`,
        cardId,
        kind: "evaluate",
        status: "timeout",
        exitReason: "evaluation timed out",
        worktreePath,
        branch: `ralph/loop-${cardId}`,
        baseBranch: "main",
        startedAt: started.toISOString(),
        endedAt: new Date(started.getTime() + 60_000).toISOString(),
      })
      .run();
  }

  it("runs the gate before the evaluator and hands its result over as evidence", async () => {
    setGate("printf 'gate says hi'; exit 3");
    seedCard("card-gate");
    const planId = seedPlan("card-gate");
    const { worktreePath } = seedLoopRun("card-gate", planId);
    mockEvaluationVerdict("VERDICT: approve\n\nFine.");
    const deps = makeDeps();

    await new EvaluationService(deps).runEvaluator("card-gate");

    const gateMd = fs.readFileSync(gatePath(worktreePath), "utf8");
    expect(gateMd).toContain("Command: `printf 'gate says hi'; exit 3`");
    expect(gateMd).toContain("Result: exit 3");
    expect(gateMd).toContain("gate says hi");
    const prompt = mocks.runHarness.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("REPOSITORY GATE");
    expect(prompt).toContain("Result: exit 3");
    expect(prompt).toContain("gate says hi");
    expect(JSON.parse(eventsOfType("gate.started")[0].payload)).toEqual({ command: "printf 'gate says hi'; exit 3" });
    expect(JSON.parse(eventsOfType("gate.finished")[0].payload)).toMatchObject({ exitCode: 3, timedOut: false, error: null });
    expect(deps.moveCard).toHaveBeenCalledWith("card-gate", "evaluating", "review", "evaluator approved");
  });

  it("runs no gate and adds no section for a repository without one", async () => {
    seedCard("card-nogate");
    const planId = seedPlan("card-nogate");
    const { worktreePath } = seedLoopRun("card-nogate", planId);
    mockEvaluationVerdict("VERDICT: approve\n\nFine.");

    await new EvaluationService(makeDeps()).runEvaluator("card-nogate");

    expect(fs.existsSync(gatePath(worktreePath))).toBe(false);
    expect(mocks.runHarness.mock.calls[0][0].prompt).not.toContain("REPOSITORY GATE");
    expect(eventsOfType("gate.started")).toHaveLength(0);
  });

  it("reuses the cycle's gate result on a retry of the evaluator", async () => {
    const marker = path.join(testDataDir, "gate-ran-on-retry");
    setGate(`touch ${marker}`);
    seedCard("card-reuse");
    const planId = seedPlan("card-reuse");
    const { worktreePath } = seedLoopRun("card-reuse", planId);
    seedFailedEvaluate("card-reuse", worktreePath);
    fs.writeFileSync(gatePath(worktreePath), "# Repository gate\n\nCommand: `earlier`\nResult: exit 0\n");
    mockEvaluationVerdict("VERDICT: approve\n\nFine.");

    await new EvaluationService(makeDeps()).runEvaluator("card-reuse");

    expect(fs.existsSync(marker)).toBe(false);
    expect(mocks.runHarness.mock.calls[0][0].prompt).toContain("Command: `earlier`");
    expect(eventsOfType("gate.started")).toHaveLength(0);
  });

  it("runs the gate again when a new loop run has started a fresh cycle", async () => {
    const marker = path.join(testDataDir, "gate-ran-fresh");
    setGate(`touch ${marker}`);
    seedCard("card-fresh-gate");
    const planId = seedPlan("card-fresh-gate");
    const { worktreePath } = seedLoopRun("card-fresh-gate", planId);
    fs.writeFileSync(gatePath(worktreePath), "# Repository gate\n\nCommand: `stale`\nResult: exit 1\n");
    mockEvaluationVerdict("VERDICT: approve\n\nFine.");

    await new EvaluationService(makeDeps()).runEvaluator("card-fresh-gate");

    expect(fs.existsSync(marker)).toBe(true);
    const gateMd = fs.readFileSync(gatePath(worktreePath), "utf8");
    expect(gateMd).toContain(`Command: \`touch ${marker}\``);
    expect(gateMd).not.toContain("stale");
    expect(eventsOfType("gate.finished")).toHaveLength(1);
  });

  it("stops quietly when the card is cancelled while the gate runs", async () => {
    setGate("sleep 5");
    seedCard("card-cancel-gate");
    const planId = seedPlan("card-cancel-gate");
    const { worktreePath } = seedLoopRun("card-cancel-gate", planId);
    const deps = makeDeps();
    deps.registerController.mockImplementation((_runId: string, controller: AbortController) => {
      setTimeout(() => controller.abort(), 100);
    });

    await new EvaluationService(deps).runEvaluator("card-cancel-gate");

    expect(mocks.runHarness).not.toHaveBeenCalled();
    expect(fs.existsSync(gatePath(worktreePath))).toBe(false);
    expect(deps.releaseController).toHaveBeenCalled();
  });
});
