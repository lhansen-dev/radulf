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
    }),
}));

const testDataDir = setupTestDataDir("radulf-planningService-");
const { testSettings } = await import("@/testUtils/testSettings");

const { db, cards, plans, runs, repos, scopingMessages, worktrees, now } = await import("@/db");
// Imported after setupTestDataDir, like everything else that reaches @/db: a
// static import of this module fixes DATA_DIR at load and puts the file on
// the checkout's own database, where it raced other test files.
const { PlanningService, pendingReplanFeedback, planningDestination, clearPlannerArtifacts, renderPlanPrompt } =
  await import("./planningService");
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

function seedCard(id: string, reviewPlanBeforeImplementation: 0 | 1 = 0) {
  db.insert(cards)
    .values({
      id,
      repoId: "repo-1",
      title: `Card ${id}`,
      description: "Planning service test card",
      status: "planning",
      baseBranch: "main",
      reviewPlanBeforeImplementation,
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
    latestPlan: (id: string) => db.select().from(plans).where(eq(plans.cardId, id)).get(),
    latestWorktreeRun: (id: string) => db.select().from(runs).where(eq(runs.cardId, id)).get(),
    moveCard: vi.fn(() => true),
    finishRun: vi.fn(() => true),
    registerController: vi.fn(),
    releaseController: vi.fn(),
    pump: vi.fn(),
  };
}

const completeArtifacts = {
  "PLAN.md": "## Tasks\n- [ ] implement the thing\n",
  "CRITERIA.md": "The thing is implemented.",
  "PROMPT.md": "Implement the thing.",
};

describe("PlanningService.runPlanning", () => {
  beforeEach(() => {
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
