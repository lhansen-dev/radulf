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
// exact boundary instead: revision #2 must still re-loop, revision #3 must
// trip the cap. See PLAN.md Phase 11.

const mocks = vi.hoisted(() => ({
  runHarness: vi.fn(),
  tryGit: vi.fn(),
  // Mutable so the Phase 18.1 regression test below can flip sandboxing on
  // for just that one test (it needs a real git repo + real srtConfig build
  // to reproduce the FK-ordering bug) without disturbing every other test in
  // this file, which deliberately keeps sandboxing off — see the comment on
  // `sandboxEnabled` below.
  settings: {
    evaluatorProvider: "anthropic",
    evaluatorModel: "evaluator-model",
    evaluatorReasoningLevel: "medium",
    evaluatorPromptTemplate: "Evaluate {{TITLE}} from {{BASE_BRANCH}}\n{{DESCRIPTION}}\n{{CRITERIA}}",
    // Lifecycle tests use plain mkdtemp worktrees, not real git repos — same
    // reasoning applies here: sandboxEnabled:false keeps createRunSandbox
    // from resolving a real git-common-dir against a fake worktree.
    sandboxEnabled: false,
    sandboxNetworkAllowlist: "",
    sandboxWeakerIsolationForGoTls: false,
  },
}));

vi.mock("./harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./harness")>()),
  runHarness: mocks.runHarness,
}));
vi.mock("./git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./git")>()),
  tryGit: mocks.tryGit,
}));
vi.mock("./settings", () => ({
  getSettings: () => mocks.settings,
}));

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-evaluationService-"));
process.env.RADULF_DATA_DIR = testDataDir;

const { db, cards, events, plans, runs, repos, now } = await import("@/db");
const { EvaluationService } = await import("./evaluationService");
const { planStatePath } = await import("./bookkeeping");

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

/** Seed the orchestrator-private PLAN.md a revise verdict appends its
 * feedback task to (evaluationService.ts throws if this is missing). */
function seedPlanState(cardId: string) {
  const p = planStatePath(cardId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "## Tasks\n- [ ] implement the thing\n");
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
    approveReview: vi.fn(async () => ({ ok: true })),
  };
}

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
    mocks.settings.sandboxEnabled = false;
    mocks.settings.sandboxWeakerIsolationForGoTls = false;
    seedRepo();
  });

  afterAll(() => {
    fs.rmSync(testDataDir, { recursive: true, force: true });
    delete process.env.RADULF_DATA_DIR;
  });

  it("approves and advances the card to review", async () => {
    seedCard("card-approve");
    const planId = seedPlan("card-approve");
    seedLoopRun("card-approve", planId);
    mockEvaluationVerdict("VERDICT: approve\n\nLooks solid.");
    const deps = makeDeps();

    await new EvaluationService(deps).runEvaluator("card-approve");

    expect(deps.moveCard).toHaveBeenCalledWith("card-approve", "evaluating", "review", "evaluator approved");
    expect(deps.finishRun).toHaveBeenCalledWith(expect.any(String), "completed", "approve", expect.any(Object));
    expect(deps.pump).not.toHaveBeenCalled();
  });

  it("revises normally when exactly one prior revision exists — below MAX_EVALUATOR_REVISIONS (2)", async () => {
    seedCard("card-revise-below-cap");
    const planId = seedPlan("card-revise-below-cap");
    seedLoopRun("card-revise-below-cap", planId);
    seedPriorRevisions("card-revise-below-cap", 1);
    seedPlanState("card-revise-below-cap");
    mockEvaluationVerdict("VERDICT: revise\n\nStill missing tests.");
    const deps = makeDeps();

    await new EvaluationService(deps).runEvaluator("card-revise-below-cap");

    expect(deps.moveCard).toHaveBeenCalledWith(
      "card-revise-below-cap",
      "evaluating",
      "ready",
      "evaluator requested changes",
    );
    expect(deps.finishRun).toHaveBeenCalledWith(expect.any(String), "completed", "revise", expect.any(Object));
    expect(deps.pump).toHaveBeenCalledTimes(1);

    // A new plan version was queued rather than escalating to human review.
    const versions = db
      .select()
      .from(plans)
      .where(eq(plans.cardId, "card-revise-below-cap"))
      .all()
      .map((p) => p.version)
      .sort();
    expect(versions).toEqual([1, 2]);
  });

  it("trips MAX_EVALUATOR_REVISIONS exactly at 2 prior revisions — not 1 before, not 3 after", async () => {
    seedCard("card-revise-at-cap");
    const planId = seedPlan("card-revise-at-cap");
    seedLoopRun("card-revise-at-cap", planId);
    seedPriorRevisions("card-revise-at-cap", 2);
    seedPlanState("card-revise-at-cap");
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
    // The capped path never re-queues the loop.
    expect(deps.pump).not.toHaveBeenCalled();

    // No new plan version — the card escalates instead of looping again.
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
