import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

describe("planningDestination", () => {
  it("routes on truthiness, not `=== 1`, so DB drift cannot misroute a card", () => {
    expect(planningDestination({ reviewPlanBeforeImplementation: 0 })).toBe("ready");
    for (const v of [1, 2, -1]) {
      expect(planningDestination({ reviewPlanBeforeImplementation: v })).toBe("plan_review");
    }
  });
});

describe("renderPlanPrompt", () => {
  it("fills the placeholders and adds a reviewer-feedback section", () => {
    const rendered = renderPlanPrompt(
      "{{TITLE}}\n{{DESCRIPTION}}\n{{FEEDBACK_SECTION}}",
      "Add templates",
      "Make prompts configurable",
      "Keep the existing defaults",
    );

    expect(rendered).toContain("Add templates\nMake prompts configurable");
    expect(rendered).toContain("PREVIOUS ATTEMPT — REVIEWER FEEDBACK");
    expect(rendered).toContain("Keep the existing defaults");
    expect(rendered).not.toContain("SCOPING THREAD");
  });

  it("renders the scoping thread with every speaker named, after the description", () => {
    const rendered = renderPlanPrompt(
      "{{TITLE}}\n{{DESCRIPTION}}\n{{SCOPING_SECTION}}\n{{FEEDBACK_SECTION}}",
      "Add templates",
      "Make prompts configurable",
      undefined,
      [
        { role: "planner", content: "1. Per repo or per workspace?" },
        { role: "user", content: "Per workspace." },
        { role: "assistant", content: "Settled: workspace-wide." },
      ],
    );

    expect(rendered).toContain("Make prompts configurable\n\nSCOPING THREAD");
    expect(rendered).toContain("Planner (an earlier planning run): 1. Per repo or per workspace?");
    expect(rendered).toContain("Operator: Per workspace.");
    expect(rendered).toContain("Scoping assistant: Settled: workspace-wide.");
  });

  it("still delivers the thread to a template customized before the placeholder existed", () => {
    const rendered = renderPlanPrompt(
      "{{TITLE}}\n{{DESCRIPTION}}\n{{FEEDBACK_SECTION}}",
      "Add templates",
      "Make prompts configurable",
      undefined,
      [{ role: "user", content: "Per workspace." }],
    );

    expect(rendered).toContain("Make prompts configurable\n\nSCOPING THREAD");
    expect(rendered).toContain("Operator: Per workspace.");
  });
});

describe("clearPlannerArtifacts", () => {
  it("removes every planner file including QUESTIONS.md but leaves everything else", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-planning-artifacts-"));
    try {
      const ralphDir = path.join(dir, ".ralph");
      fs.mkdirSync(ralphDir, { recursive: true });
      for (const name of ["PLAN.md", "CRITERIA.md", "PROMPT.md", "QUESTIONS.md", "KEEP.md"]) {
        fs.writeFileSync(path.join(ralphDir, name), "content");
      }

      clearPlannerArtifacts(dir);

      for (const name of ["PLAN.md", "CRITERIA.md", "PROMPT.md", "QUESTIONS.md"]) {
        expect(fs.existsSync(path.join(ralphDir, name))).toBe(false);
      }
      expect(fs.existsSync(path.join(ralphDir, "KEEP.md"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op (never throws) when the worktree has no .ralph dir at all", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-planning-artifacts-"));
    try {
      expect(() => clearPlannerArtifacts(dir)).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

const mocks = vi.hoisted(() => ({
  runHarness: vi.fn(),
  createWorktree: vi.fn(),
  tryGit: vi.fn(),
  // The fixture worktree is not a real checkout; the guard would otherwise
  // report it as no longer sharing the repository's git dir.
  offRunBranchReason: vi.fn().mockResolvedValue(null),
}));

vi.mock("./harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./harness")>()),
  runHarness: mocks.runHarness,
}));
vi.mock("./git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./git")>()),
  createWorktree: mocks.createWorktree,
  tryGit: mocks.tryGit,
  offRunBranchReason: mocks.offRunBranchReason,
}));
vi.mock("./settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settings")>()),
  getSettings: () =>
    testSettings({
      plannerModel: "planner-model",
      plannerTimeoutMinutes: 42,
      plannerPromptTemplate: "Plan {{TITLE}}\n{{DESCRIPTION}}\n{{FEEDBACK_SECTION}}",
      sandboxEnabled: false,
      // Spec 30: the routing tests below expect a plan to go straight to
      // ready; a card opts into the critic explicitly where it is tested.
      planCriticMode: "off",
    }),
}));

const testDataDir = setupTestDataDir("radulf-planningService-");
const { testSettings } = await import("@/testUtils/testSettings");

const { db, cards, plans, runs, repos, scopingMessages, worktrees, events, now } = await import("@/db");
// Imported after setupTestDataDir, like everything else that reaches @/db: a
// static import of this module fixes DATA_DIR at load and puts the file on
// the checkout's own database, where it raced other test files.
const {
  PlanningService,
  pendingReplanFeedback,
  planningDestination,
  clearPlannerArtifacts,
  renderPlanPrompt,
  writePlanRow,
} = await import("./planningService");
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

function seedCard(id: string, reviewPlanBeforeImplementation: 0 | 1 = 0, planCritic: 0 | 1 | null = null) {
  db.insert(cards)
    .values({
      id,
      repoId: "repo-1",
      title: `Card ${id}`,
      description: "Planning service test card",
      status: "planning",
      baseBranch: "main",
      reviewPlanBeforeImplementation,
      planCritic,
      position: 1,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

/** Queue runHarness to write the given `.ralph/*` files as a side effect,
 * mirroring the real planner harness. */
function mockPlannerHarness(artifacts: Record<string, string>) {
  mocks.runHarness.mockImplementationOnce(async ({ cwd }: { cwd: string }) => {
    for (const [name, content] of Object.entries(artifacts)) {
      fs.writeFileSync(path.join(cwd, ".ralph", name), content);
    }
    return { timedOut: false, error: "", code: 0, lastText: "done" };
  });
}

function makeDeps() {
  return {
    getCard: (id: string) => db.select().from(cards).where(eq(cards.id, id)).get(),
    workerId: () => "worker-test",
    latestPlan: (id: string) => db.select().from(plans).where(eq(plans.cardId, id)).get(),
    latestWorktreeRun: (id: string) => db.select().from(runs).where(eq(runs.cardId, id)).get(),
    moveCard: vi.fn(() => true),
    finishRun: vi.fn(() => true),
    registerController: vi.fn(),
    releaseController: vi.fn(),
    pump: vi.fn(),
    critique: vi.fn(),
    replan: vi.fn(),
  };
}

const completeArtifacts = {
  "PLAN.md": "## Tasks\n- [ ] implement the thing\n",
  "CRITERIA.md": "The thing is implemented.",
  "PROMPT.md": "Implement the thing.",
};

describe("PlanningService.runPlanning", () => {
  beforeEach(() => {
    db.delete(events).run();
    db.delete(worktrees).run();
    db.delete(runs).run();
    db.delete(plans).run();
    db.delete(cards).run();
    db.delete(repos).run();
    vi.clearAllMocks();
    mocks.tryGit.mockResolvedValue({ ok: true, out: "" });
    mocks.createWorktree.mockImplementation((_repoPath: string, _base: string, _title: string, runId: string) => {
      const worktreePath = path.join(testDataDir, "worktrees", String(runId));
      fs.mkdirSync(path.join(worktreePath, ".ralph"), { recursive: true });
      return { worktreePath, branch: `ralph/${runId}` };
    });
    seedRepo();
  });

  it("routes a completed plan straight to ready when reviewPlanBeforeImplementation is 0", async () => {
    seedCard("card-ready", 0);
    mockPlannerHarness(completeArtifacts);
    const deps = makeDeps();

    await new PlanningService(deps).runPlanning("card-ready");

    expect(deps.finishRun).toHaveBeenCalledWith(
      expect.any(String),
      "completed",
      "plan artifacts written",
      expect.any(Object),
    );
    expect(deps.moveCard).toHaveBeenCalledWith("card-ready", "planning", "ready");
    expect(mocks.runHarness).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 42 * 60 * 1000 }),
    );
    const planRow = db.select().from(plans).where(eq(plans.cardId, "card-ready")).get();
    // Artifact contents are trimmed on read before being persisted.
    expect(planRow).toMatchObject({ version: 1, planMd: completeArtifacts["PLAN.md"].trim() });
    // PLAN.md is orchestrator-private: mirrored to the private plan state file.
    expect(fs.readFileSync(planStatePath("card-ready"), "utf8")).toBe(completeArtifacts["PLAN.md"].trim());
  });

  it("routes a completed plan to plan_review when reviewPlanBeforeImplementation is 1", async () => {
    seedCard("card-plan-review", 1);
    mockPlannerHarness(completeArtifacts);
    const deps = makeDeps();

    await new PlanningService(deps).runPlanning("card-plan-review");

    expect(deps.moveCard).toHaveBeenCalledWith("card-plan-review", "planning", "plan_review");
  });

  it("hands a completed plan to the critic instead of moving the card when the card opts in (spec 30)", async () => {
    seedCard("card-x", 0, 1);
    mockPlannerHarness(completeArtifacts);
    const deps = makeDeps();

    await new PlanningService(deps).runPlanning("card-x");

    expect(deps.finishRun).toHaveBeenCalledWith(
      expect.any(String),
      "completed",
      "plan artifacts written",
      expect.any(Object),
    );
    expect(deps.critique).toHaveBeenCalledWith("card-x");
    expect(deps.moveCard).not.toHaveBeenCalledWith("card-x", "planning", "ready");
    expect(deps.moveCard).not.toHaveBeenCalled();
    expect(db.select().from(events).where(eq(events.type, "plan.critique_requested")).all()).toHaveLength(1);
  });

  it("re-plans from a plan critic revise verdict, saying who the feedback came from (spec 30)", () => {
    seedCard("card-critiqued");
    db.insert(plans)
      .values({ id: "plan-critiqued", cardId: "card-critiqued", version: 1, planMd: "## Tasks\n- [ ] a\n", promptMd: "p", acceptanceCriteria: "c", createdAt: now() })
      .run();
    db.insert(runs)
      .values({
        id: "run-critique",
        cardId: "card-critiqued",
        planId: "plan-critiqued",
        kind: "critique",
        status: "completed",
        worktreePath: "/tmp/wt",
        branch: "ralph/x",
        exitReason: "revise",
        feedback: "Task 2 names a spec file that does not exist.",
        startedAt: "2026-09-21T16:14:00.000Z",
        endedAt: "2026-09-21T16:15:00.000Z",
      })
      .run();

    const feedback = pendingReplanFeedback("card-critiqued")!;
    expect(feedback.startsWith("The plan critic reviewed")).toBe(true);
    expect(feedback).toContain("Task 2 names a spec file that does not exist.");
  });

  it("re-plans from a pre-check revise, saying the checks ran against the untouched worktree (spec 31)", () => {
    seedCard("card-prechecked");
    db.insert(plans)
      .values({ id: "plan-prechecked", cardId: "card-prechecked", version: 1, planMd: "## Tasks\n- [ ] a\n", promptMd: "p", acceptanceCriteria: "c", createdAt: now() })
      .run();
    db.insert(runs)
      .values({
        id: "run-precheck",
        cardId: "card-prechecked",
        planId: "plan-prechecked",
        kind: "plan",
        status: "completed",
        worktreePath: "/tmp/wt",
        branch: "ralph/x",
        exitReason: "precheck revise",
        feedback: "Rewrite `test -f README.md`",
        startedAt: "2026-09-21T16:14:00.000Z",
        endedAt: "2026-09-21T16:15:00.000Z",
      })
      .run();

    const feedback = pendingReplanFeedback("card-prechecked")!;
    expect(feedback.startsWith("The acceptance pre-check")).toBe(true);
    expect(feedback).toContain("Rewrite `test -f README.md`");

    // The pre-check ran against the worktree as it stands, so it is never a
    // verdict on the plan's correctness — the wording says what it did.
    expect(feedback).toContain("against the untouched worktree before any work was done");
  });

  it("finishes the run and parks the card when the planner harness throws", async () => {
    // Without a catch, a throw after startRunRow left the run row `running`
    // and the card landed in needs_attention with no finished run behind it.
    seedCard("card-throws");
    mocks.runHarness.mockRejectedValueOnce(new Error("harness crashed"));
    const deps = makeDeps();

    await new PlanningService(deps).runPlanning("card-throws");

    expect(deps.finishRun.mock.calls[0].slice(0, 3)).toEqual([
      expect.any(String),
      "failed",
      expect.stringContaining("planner failed: harness crashed"),
    ]);
    expect(deps.moveCard).toHaveBeenCalledWith(
      "card-throws",
      "planning",
      "needs_attention",
      expect.stringContaining("harness crashed"),
    );
    expect(deps.pump).toHaveBeenCalled();
  });

  it("escalates to needs_attention when the planner raises follow-up questions", async () => {
    seedCard("card-questions");
    mockPlannerHarness({ "QUESTIONS.md": "Which auth provider should this use?" });
    const deps = makeDeps();

    await new PlanningService(deps).runPlanning("card-questions");

    expect(deps.moveCard).toHaveBeenCalledWith(
      "card-questions",
      "planning",
      "needs_attention",
      "planner has follow-up questions",
    );
    expect(deps.finishRun).toHaveBeenCalledWith(
      expect.any(String),
      "completed",
      "planner raised follow-up questions",
      expect.any(Object),
    );
    // No plan is ever created off a questions run.
    expect(db.select().from(plans).where(eq(plans.cardId, "card-questions")).all()).toHaveLength(0);
    // Spec 17: the questions are now part of the card's scoping thread, where
    // the operator answers them.
    expect(
      db.select().from(scopingMessages).where(eq(scopingMessages.cardId, "card-questions")).all(),
    ).toMatchObject([{ role: "planner", content: "Which auth provider should this use?" }]);
  });

  it("re-plans from a loop that stopped for the planner: a blocker, or an exhausted checklist", () => {
    seedCard("card-loop-stop");
    db.insert(plans)
      .values({ id: "plan-loop-stop", cardId: "card-loop-stop", version: 1, planMd: "## Tasks\n- [x] a\n", promptMd: "p", acceptanceCriteria: "c", createdAt: now() })
      .run();
    const loopRun = (id: string, exitReason: string, feedback: string | null, startedAt: string) =>
      db.insert(runs).values({ id, cardId: "card-loop-stop", planId: "plan-loop-stop", kind: "loop", status: "failed", worktreePath: "/tmp/wt", branch: "ralph/x", exitReason, feedback, startedAt, endedAt: startedAt }).run();

    // The real card: ticked every task, no DONE, and the row predates feedback.
    loopRun("run-exhausted", "plan checklist exhausted without a DONE signal", null, "2026-09-21T16:14:00.000Z");
    expect(pendingReplanFeedback("card-loop-stop")).toContain("never signalled DONE");

    // A newer run that reported a blocker wins, with its own words inside.
    loopRun("run-blocked", "loop blocked", "No Atlassian session in the sandbox.", "2026-09-21T16:20:00.000Z");
    const feedback = pendingReplanFeedback("card-loop-stop")!;
    expect(feedback).toContain("blocker outside its control");
    expect(feedback).toContain("No Atlassian session in the sandbox.");
    expect(feedback).toContain("Leave what only the operator can do to the operator");

    // Any other loop ending is a retry, not a re-plan.
    loopRun("run-stalled", "stalled", null, "2026-09-21T16:30:00.000Z");
    expect(pendingReplanFeedback("card-loop-stop")).toContain("No Atlassian session in the sandbox.");
  });

  it("hands the scoping thread to the planner", async () => {
    seedCard("card-scoped");
    db.insert(scopingMessages)
      .values({ cardId: "card-scoped", role: "user", content: "Only the password login path.", createdAt: now() })
      .run();
    mockPlannerHarness(completeArtifacts);

    await new PlanningService(makeDeps()).runPlanning("card-scoped");

    const prompt = mocks.runHarness.mock.calls.at(-1)![0].prompt as string;
    expect(prompt).toContain("SCOPING THREAD");
    expect(prompt).toContain("Operator: Only the password login path.");
  });

  it("escalates to needs_attention when a required artifact is missing", async () => {
    seedCard("card-malformed");
    mockPlannerHarness({
      "PLAN.md": completeArtifacts["PLAN.md"],
      "PROMPT.md": completeArtifacts["PROMPT.md"],
      // CRITERIA.md intentionally omitted.
    });
    const deps = makeDeps();

    await new PlanningService(deps).runPlanning("card-malformed");

    expect(deps.moveCard).toHaveBeenCalledWith(
      "card-malformed",
      "planning",
      "needs_attention",
      "planner produced malformed artifacts",
    );
    expect(db.select().from(plans).where(eq(plans.cardId, "card-malformed")).all()).toHaveLength(0);
  });

  it("escalates to needs_attention when PLAN.md's checklist is unparseable", async () => {
    seedCard("card-unparseable");
    mockPlannerHarness({
      "PLAN.md": "no tasks heading, no checkboxes",
      "CRITERIA.md": completeArtifacts["CRITERIA.md"],
      "PROMPT.md": completeArtifacts["PROMPT.md"],
    });
    const deps = makeDeps();

    await new PlanningService(deps).runPlanning("card-unparseable");

    expect(deps.moveCard).toHaveBeenCalledWith(
      "card-unparseable",
      "planning",
      "needs_attention",
      "plan checklist unparseable or has no unchecked tasks",
    );
  });
});

/**
 * Spec 31: the acceptance pre-check.
 *
 * The commands come out of CRITERIA.md and run in the worktree the planning run
 * is sitting in, so the fixtures have to be written there — and the only handle
 * a test has on that path is the `cwd` the mocked harness is called with (the
 * real one is minted by `mocks.createWorktree`). Hence a harness mock that
 * writes both the artifacts and the files the criteria's checks look for.
 */
function mockPlannerWrites(artifacts: Record<string, string>, files: Record<string, string> = {}) {
  mocks.runHarness.mockImplementationOnce(async ({ cwd }: { cwd: string }) => {
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(cwd, name);
      fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(target), { recursive: true });
      fs.writeFileSync(/* turbopackIgnore: true */ target, content);
    }
    for (const [name, content] of Object.entries(artifacts)) {
      fs.writeFileSync(/* turbopackIgnore: true */ path.join(cwd, ".ralph", name), content);
    }
    return { timedOut: false, error: "", code: 0, lastText: "done" };
  });
}

/** CRITERIA.md is the only artifact any pre-check test varies. */
const criteriaArtifacts = (criteria: string) => ({ ...completeArtifacts, "CRITERIA.md": criteria });

function payloadOf(type: string) {
  const rows = db.select().from(events).where(eq(events.type, type)).all();
  return rows.length ? JSON.parse(rows[0].payload) : undefined;
}

const countOf = (type: string) =>
  db.select().from(events).where(eq(events.type, type)).all().length;

const planRowOf = (cardId: string) => db.select().from(plans).where(eq(plans.cardId, cardId)).get();
const planRunOf = (cardId: string) =>
  db.select().from(runs).where(eq(runs.cardId, cardId)).all().find((r) => r.kind === "plan")!;

describe("PlanningService.runPlanning — the acceptance pre-check (spec 31)", () => {
  beforeEach(() => {
    db.delete(events).run();
    db.delete(worktrees).run();
    db.delete(runs).run();
    db.delete(plans).run();
    db.delete(cards).run();
    db.delete(repos).run();
    vi.clearAllMocks();
    mocks.tryGit.mockResolvedValue({ ok: true, out: "" });
    mocks.createWorktree.mockImplementation((_repoPath: string, _base: string, _title: string, runId: string) => {
      const worktreePath = path.join(testDataDir, "worktrees", String(runId));
      fs.mkdirSync(path.join(worktreePath, ".ralph"), { recursive: true });
      return { worktreePath, branch: `ralph/${runId}` };
    });
    seedRepo();
  });

  it("sends a plan whose checks already pass on the untouched worktree back for one rewrite", async () => {
    seedCard("card-pre-pass");
    // README.md is already there: the check cannot show this card's work.
    mockPlannerWrites(criteriaArtifacts("- [ ] `test -f README.md` succeeds"), {
      "README.md": "# already here\n",
    });
    const deps = makeDeps();

    await new PlanningService(deps).runPlanning("card-pre-pass");

    expect(payloadOf("acceptance.precheck")).toMatchObject({
      version: 1,
      checked: 1,
      alreadyPassingCount: 1,
      skippedCount: 0,
      alreadyPassing: ["test -f README.md"],
      failing: [],
      unprobed: [],
      skipped: [],
      revise: true,
    });
    expect(payloadOf("plan.precheck_revise_requested")).toMatchObject({
      version: 1,
      alreadyPassing: ["test -f README.md"],
    });
    // The pre-check's own verdict is what the next planning run re-plans from,
    // so it has to be on the row: finishRun is a mock and writes nothing, the
    // exit reason above travels with it and the feedback below is the real
    // update this service makes itself.
    expect(deps.finishRun).toHaveBeenCalledWith(
      expect.any(String),
      "completed",
      "precheck revise",
      expect.any(Object),
    );
    expect(planRunOf("card-pre-pass").feedback).toContain("`test -f README.md`");
    expect(deps.replan).toHaveBeenCalledWith("card-pre-pass");
    // The card never reaches the critic or the loop on a pre-check revise.
    expect(deps.critique).not.toHaveBeenCalled();
    expect(deps.moveCard).not.toHaveBeenCalled();
    // Recorded on the plan row, so the post-DONE probe can report these without
    // spending its one repair iteration on them.
    expect(JSON.parse(planRowOf("card-pre-pass")!.precheckPassing!)).toEqual(["test -f README.md"]);
  });

  it("routes a plan whose checks fail — the healthy case for new behaviour — on to ready", async () => {
    seedCard("card-pre-fail");
    mockPlannerWrites(criteriaArtifacts("- [ ] `test -f new-file.md` succeeds"));
    const deps = makeDeps();

    await new PlanningService(deps).runPlanning("card-pre-fail");

    // A failing check here is what a check for new behaviour is supposed to do;
    // it is never a finding.
    expect(payloadOf("acceptance.precheck")).toMatchObject({
      checked: 1,
      alreadyPassing: [],
      failing: ["test -f new-file.md"],
      revise: false,
    });
    expect(countOf("plan.precheck_revise_requested")).toBe(0);
    expect(deps.replan).not.toHaveBeenCalled();
    expect(deps.finishRun).toHaveBeenCalledWith(
      expect.any(String),
      "completed",
      "plan artifacts written",
      expect.any(Object),
    );
    expect(deps.moveCard).toHaveBeenCalledWith("card-pre-fail", "planning", "ready");
  });

  it("says nothing at all for a criteria document with no runnable command", async () => {
    seedCard("card-pre-prose");
    mockPlannerWrites(criteriaArtifacts("The thing is implemented."));
    const deps = makeDeps();

    await new PlanningService(deps).runPlanning("card-pre-prose");

    expect(countOf("acceptance.precheck")).toBe(0);
    expect(countOf("plan.precheck_revise_requested")).toBe(0);
    expect(deps.replan).not.toHaveBeenCalled();
    expect(deps.finishRun).toHaveBeenCalledWith(
      expect.any(String),
      "completed",
      "plan artifacts written",
      expect.any(Object),
    );
    expect(deps.moveCard).toHaveBeenCalledWith("card-pre-prose", "planning", "ready");
    // Distinguishable from "checked, and nothing passed": never pre-checked.
    expect(planRowOf("card-pre-prose")!.precheckPassing).toBeNull();
  });

  it("collects `## Regression` checks as skipped and never runs them", async () => {
    seedCard("card-pre-regression");
    // Passing now is the whole point of a regression check, so it is exempt.
    mockPlannerWrites(
      criteriaArtifacts("## Regression\n- [ ] `test -f README.md` succeeds"),
      { "README.md": "# already here\n" },
    );
    const deps = makeDeps();

    await new PlanningService(deps).runPlanning("card-pre-regression");

    expect(payloadOf("acceptance.precheck")).toMatchObject({
      checked: 0,
      alreadyPassing: [],
      failing: [],
      skipped: ["test -f README.md"],
      skippedCount: 1,
      revise: false,
    });
    expect(deps.replan).not.toHaveBeenCalled();
    expect(deps.moveCard).toHaveBeenCalledWith("card-pre-regression", "planning", "ready");
  });

  it("reports an already-passing check but never re-plans twice on the same plan", async () => {
    seedCard("card-pre-cap");
    // The card has already been through one pre-check revise: the finding is
    // recorded, and the plan ships as written rather than looping.
    const priorId = "plan-run-pre-cap";
    const priorPath = path.join(testDataDir, "worktrees", priorId);
    fs.mkdirSync(path.join(priorPath, ".ralph"), { recursive: true });
    db.insert(runs)
      .values({
        id: priorId,
        cardId: "card-pre-cap",
        kind: "plan",
        status: "completed",
        exitReason: "precheck revise",
        worktreePath: priorPath,
        branch: `ralph/${priorId}`,
        baseBranch: "main",
        startedAt: new Date(Date.now() - 600_000).toISOString(),
        endedAt: new Date(Date.now() - 590_000).toISOString(),
      })
      .run();
    mockPlannerWrites(criteriaArtifacts("`test -f README.md` succeeds"), {
      "README.md": "# already here\n",
    });
    const deps = makeDeps();

    await new PlanningService(deps).runPlanning("card-pre-cap");

    expect(payloadOf("acceptance.precheck")).toMatchObject({
      alreadyPassing: ["test -f README.md"],
      revise: false,
    });
    expect(countOf("plan.precheck_revise_requested")).toBe(0);
    expect(deps.replan).not.toHaveBeenCalled();
    expect(deps.finishRun).toHaveBeenCalledWith(
      expect.any(String),
      "completed",
      "plan artifacts written",
      expect.any(Object),
    );
    expect(deps.moveCard).toHaveBeenCalledWith("card-pre-cap", "planning", "ready");
  });
});

// Spec 26: a retry inherits the attempt it retries.
const { runTranscriptDir } = await import("./retention");

describe("PlanningService.runPlanning — retries inherit the failed attempt (spec 26)", () => {
  beforeEach(() => {
    db.delete(events).run();
    db.delete(worktrees).run();
    db.delete(runs).run();
    db.delete(plans).run();
    db.delete(cards).run();
    db.delete(repos).run();
    vi.clearAllMocks();
    mocks.tryGit.mockResolvedValue({ ok: true, out: "" });
    mocks.createWorktree.mockImplementation((_repoPath: string, _base: string, _title: string, runId: string) => {
      const worktreePath = path.join(testDataDir, "worktrees", String(runId));
      fs.mkdirSync(path.join(worktreePath, ".ralph"), { recursive: true });
      return { worktreePath, branch: `ralph/${runId}` };
    });
    seedRepo();
  });

  /** A timed-out planning attempt with its own worktree, which the retry reuses. */
  function seedFailedPlanRun(cardId: string) {
    const id = `plan-failed-${cardId}`;
    const worktreePath = path.join(testDataDir, "worktrees", id);
    fs.mkdirSync(path.join(worktreePath, ".ralph"), { recursive: true });
    const started = new Date(Date.now() + 60_000);
    db.insert(runs)
      .values({
        id,
        cardId,
        kind: "plan",
        status: "timeout",
        exitReason: "planning timed out",
        worktreePath,
        branch: `ralph/${id}`,
        baseBranch: "main",
        startedAt: started.toISOString(),
        endedAt: new Date(started.getTime() + 60_000).toISOString(),
      })
      .run();
    return { id, worktreePath };
  }

  it("forwards the killed attempt's drafts and digest into the retry prompt", async () => {
    seedCard("card-retry");
    const { id, worktreePath } = seedFailedPlanRun("card-retry");
    fs.writeFileSync(path.join(worktreePath, ".ralph", "PLAN.md"), "## Tasks\n- [ ] half a plan\n");
    const dir = runTranscriptDir(id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "plan.jsonl"), `${JSON.stringify({ t: "tool", name: "read", input: { path: "README.md" } })}\n`);
    mockPlannerHarness(completeArtifacts);
    const deps = makeDeps();

    await new PlanningService(deps).runPlanning("card-retry");

    const call = mocks.runHarness.mock.calls[0][0];
    expect(call.cwd).toBe(worktreePath);
    expect(call.prompt).toContain("PREVIOUS ATTEMPT OF THIS STAGE");
    expect(call.prompt).toContain("ended with: planning timed out after 1 minute.");
    expect(call.prompt).toContain("Its draft .ralph/PLAN.md, incomplete and unverified:\n## Tasks\n- [ ] half a plan");
    expect(call.prompt).toContain("1. read: README.md");
    expect(call.prompt).toContain("ATTEMPT BUDGET");
    expect(call.prompt).toContain("hard budget is 42 minutes");
    expect(deps.moveCard).toHaveBeenCalledWith("card-retry", "planning", "ready");
    const forwarded = db.select().from(events).where(eq(events.type, "attempt.forwarded")).all();
    expect(forwarded).toHaveLength(1);
    expect(JSON.parse(forwarded[0].payload)).toMatchObject({ kind: "plan", previousRunId: id, toolCalls: 1 });
  });

  it("gives a first attempt the budget but no previous-attempt section", async () => {
    seedCard("card-first");
    mockPlannerHarness(completeArtifacts);

    await new PlanningService(makeDeps()).runPlanning("card-first");

    const prompt = mocks.runHarness.mock.calls[0][0].prompt as string;
    expect(prompt).not.toContain("PREVIOUS ATTEMPT OF THIS STAGE");
    expect(prompt).toContain("the three plan artifacts in `.ralph/` written by");
  });

  it("honours complete artifacts the attempt wrote before the watchdog killed it", async () => {
    seedCard("card-late");
    mocks.runHarness.mockImplementationOnce(async ({ cwd }: { cwd: string }) => {
      for (const [name, content] of Object.entries(completeArtifacts)) {
        fs.writeFileSync(path.join(cwd, ".ralph", name), content);
      }
      return { timedOut: true, stalled: false, error: "stopReason: aborted", code: 1, lastText: "" };
    });
    const deps = makeDeps();

    await new PlanningService(deps).runPlanning("card-late");

    expect(deps.finishRun).toHaveBeenCalledWith(expect.any(String), "completed", "plan artifacts written", expect.any(Object));
    expect(deps.moveCard).toHaveBeenCalledWith("card-late", "planning", "ready");
    expect(db.select().from(plans).where(eq(plans.cardId, "card-late")).all()).toHaveLength(1);
    expect(db.select().from(events).where(eq(events.type, "plan.recovered_after_timeout")).all()).toHaveLength(1);
  });

  it("still fails a timeout that left the artifacts incomplete", async () => {
    seedCard("card-dead");
    mocks.runHarness.mockImplementationOnce(async ({ cwd }: { cwd: string }) => {
      fs.writeFileSync(path.join(cwd, ".ralph", "PLAN.md"), "## Tasks\n- [ ] only the plan\n");
      return { timedOut: true, stalled: false, error: "", code: 1, lastText: "" };
    });
    const deps = makeDeps();

    await new PlanningService(deps).runPlanning("card-dead");

    expect(deps.finishRun).toHaveBeenCalledWith(expect.any(String), "timeout", "planning timed out", expect.any(Object));
    expect(deps.moveCard).toHaveBeenCalledWith("card-dead", "planning", "needs_attention", "planning timed out");
  });
});

describe("writePlanRow — precheck_passing (spec 31)", () => {
  const artifacts = {
    planMd: "## Tasks\n- [ ] implement the thing\n",
    promptMd: "Implement the thing.",
    acceptanceCriteria: "The thing is implemented.",
  };

  beforeEach(() => {
    db.delete(events).run();
    db.delete(plans).run();
    db.delete(cards).run();
    db.delete(repos).run();
    seedRepo();
  });

  it("remembers the checks that already passed on the untouched worktree", () => {
    seedCard("card-precheck-passing");

    const { planId } = writePlanRow("card-precheck-passing", artifacts, {
      origin: "planner",
      precheckPassing: ["test -f a"],
    });

    const row = db.select().from(plans).where(eq(plans.id, planId)).get();
    expect(row?.precheckPassing).toBe(JSON.stringify(["test -f a"]));
  });

  it("leaves the column null for a plan written without a pre-check", () => {
    seedCard("card-precheck-absent");

    const { planId } = writePlanRow("card-precheck-absent", artifacts, { origin: "planner" });

    const row = db.select().from(plans).where(eq(plans.id, planId)).get();
    expect(row?.precheckPassing).toBeNull();
  });
});
