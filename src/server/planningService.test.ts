import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { planningDestination, clearPlannerArtifacts } from "./planningService";

// Direct unit tests for planningService.ts. `planningDestination` is already
// exercised for the literal DB values 1/0 in orchestrator.test.ts; the
// dedicated cases below are narrower — non-canonical truthy integers, to
// confirm the branch is a genuine truthiness check rather than a `=== 1`
// comparison that would silently misroute anything else DB drift might
// produce. `runPlanning` itself is covered end to end below, tying each
// `planningDestination` branch to the real card-status transition it drives.
// See PLAN.md Phase 11.

describe("planningDestination", () => {
  it("routes to plan_review for the canonical truthy value (1)", () => {
    expect(planningDestination({ reviewPlanBeforeImplementation: 1 })).toBe("plan_review");
  });

  it("routes to ready for the canonical falsy value (0)", () => {
    expect(planningDestination({ reviewPlanBeforeImplementation: 0 })).toBe("ready");
  });

  it("treats any non-zero integer as truthy, not just 1", () => {
    expect(planningDestination({ reviewPlanBeforeImplementation: 2 })).toBe("plan_review");
    expect(planningDestination({ reviewPlanBeforeImplementation: -1 })).toBe("plan_review");
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
}));

vi.mock("./harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./harness")>()),
  runHarness: mocks.runHarness,
}));
vi.mock("./git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./git")>()),
  createWorktree: mocks.createWorktree,
  tryGit: mocks.tryGit,
}));
vi.mock("./settings", () => ({
  getSettings: () => ({
    plannerProvider: "anthropic",
    plannerModel: "planner-model",
    plannerReasoningLevel: "medium",
    plannerTimeoutMinutes: 42,
    plannerPromptTemplate: "Plan {{TITLE}}\n{{DESCRIPTION}}\n{{FEEDBACK_SECTION}}",
    sandboxEnabled: false,
    sandboxNetworkAllowlist: "",
    sandboxWeakerIsolationForGoTls: false,
  }),
}));

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-planningService-"));
process.env.RADULF_DATA_DIR = testDataDir;

const { db, cards, plans, runs, repos, worktrees, now } = await import("@/db");
const { PlanningService } = await import("./planningService");
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

  afterAll(() => {
    fs.rmSync(testDataDir, { recursive: true, force: true });
    delete process.env.RADULF_DATA_DIR;
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
