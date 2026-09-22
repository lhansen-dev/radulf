import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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
    evaluatorProvider: "anthropic",
    evaluatorModel: "evaluator-model",
    evaluatorReasoningLevel: "medium",
    evaluatorTimeoutMinutes: 10,
    evaluatorPromptTemplate: "Evaluate {{TITLE}} from {{BASE_BRANCH}}\n{{DESCRIPTION}}\n{{CRITERIA}}",
    // Lifecycle tests use plain mkdtemp worktrees, not real git repos — same
    // reasoning applies here: sandboxEnabled:false keeps createRunSandbox
    // from resolving a real git-common-dir against a fake worktree.
    sandboxEnabled: false,
    sandboxNetworkAllowlist: "",
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
vi.mock("./settings", () => ({
  getSettings: () => mocks.settings,
}));

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-evaluationService-"));
process.env.RADULF_DATA_DIR = testDataDir;

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

  afterAll(() => {
    fs.rmSync(testDataDir, { recursive: true, force: true });
    delete process.env.RADULF_DATA_DIR;
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
