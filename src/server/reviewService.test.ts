import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Direct unit tests for ReviewService. `appendFeedbackTask` (private) is
// exercised only through its public call site's observable effect —
// the orchestrator-private plan-state file gaining the injected feedback
// task — rather than exporting it just to test it directly. See PLAN.md
// Phase 11.

const mocks = vi.hoisted(() => ({
  mergeBranch: vi.fn(),
  mergeBaseIntoWorktree: vi.fn(),
  removeWorktree: vi.fn(),
}));

vi.mock("./git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./git")>()),
  mergeBranch: mocks.mergeBranch,
  mergeBaseIntoWorktree: mocks.mergeBaseIntoWorktree,
  removeWorktree: mocks.removeWorktree,
}));

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-reviewService-"));
process.env.RADULF_DATA_DIR = testDataDir;

const { db, cards, plans, runs, repos, reviews, now } = await import("@/db");
const { ReviewService } = await import("./reviewService");
const { planStatePath } = await import("./bookkeeping");
const { pendingReplanFeedback } = await import("./planningService");

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

function seedCard(id: string, status: "review" = "review") {
  db.insert(cards)
    .values({
      id,
      repoId: "repo-1",
      title: `Card ${id}`,
      description: "Review service test card",
      status,
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

/** The completed loop run under review — a real worktree dir (reject/approve
 * write/read `.ralph/*` there) plus the FK-required `runs` row. */
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

/** Seed the orchestrator-private PLAN.md appendFeedbackTask writes to. */
function seedPlanState(cardId: string) {
  const p = planStatePath(cardId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "## Tasks\n- [ ] implement the thing\n");
}

function makeDeps() {
  return {
    getCard: (id: string) => db.select().from(cards).where(eq(cards.id, id)).get(),
    latestPlan: (id: string) =>
      db.select().from(plans).where(eq(plans.cardId, id)).orderBy(desc(plans.version)).limit(1).get(),
    latestWorktreeRun: (id: string) =>
      db.select().from(runs).where(eq(runs.cardId, id)).orderBy(desc(runs.startedAt)).limit(1).get(),
    moveCard: vi.fn(() => true),
    pump: vi.fn(),
  };
}

describe("ReviewService — feedback re-entry", () => {
  beforeEach(() => {
    db.delete(reviews).run();
    db.delete(runs).run();
    db.delete(plans).run();
    db.delete(cards).run();
    db.delete(repos).run();
    vi.clearAllMocks();
    seedRepo();
  });

  afterAll(() => {
    fs.rmSync(testDataDir, { recursive: true, force: true });
    delete process.env.RADULF_DATA_DIR;
  });

  it("reject() sends the card back to the planner with the feedback pending", async () => {
    seedCard("card-reject");
    const planId = seedPlan("card-reject");
    const { id: runId } = seedLoopRun("card-reject", planId);
    seedPlanState("card-reject");
    const before = fs.readFileSync(planStatePath("card-reject"), "utf8");
    const deps = makeDeps();

    new ReviewService(deps).reject(runId, "Please handle the empty-input case.");

    expect(deps.moveCard).toHaveBeenCalledWith(
      "card-reject",
      "reviewing",
      "todo",
      "rejected with feedback — re-planning",
    );
    expect(deps.pump).toHaveBeenCalledTimes(1);
    const reviewRows = db.select().from(reviews).where(eq(reviews.runId, runId)).all();
    expect(reviewRows).toHaveLength(1);
    expect(reviewRows[0].decision).toBe("rejected");
    // The planner writes the next plan version and checklist, not the reject.
    const versions = db.select().from(plans).where(eq(plans.cardId, "card-reject")).all().map((p) => p.version);
    expect(versions).toEqual([1]);
    expect(fs.readFileSync(planStatePath("card-reject"), "utf8")).toBe(before);
    expect(pendingReplanFeedback("card-reject")).toBe("Please handle the empty-input case.");
  });

  it("a rejection stops being pending once the planner writes a newer plan", () => {
    seedCard("card-replanned");
    const planId = seedPlan("card-replanned");
    const { id: runId } = seedLoopRun("card-replanned", planId);

    new ReviewService(makeDeps()).reject(runId, "Rename the flag.");
    expect(pendingReplanFeedback("card-replanned")).toBe("Rename the flag.");

    seedPlan("card-replanned", 2);
    expect(pendingReplanFeedback("card-replanned")).toBeNull();
  });

  it("does not touch the plan state when reject() throws before claiming the run", () => {
    seedCard("card-reject-empty-feedback");
    const planId = seedPlan("card-reject-empty-feedback");
    const { id: runId } = seedLoopRun("card-reject-empty-feedback", planId);
    seedPlanState("card-reject-empty-feedback");
    const before = fs.readFileSync(planStatePath("card-reject-empty-feedback"), "utf8");
    const deps = makeDeps();

    expect(() => new ReviewService(deps).reject(runId, "   ")).toThrow(/feedback is required/);

    expect(fs.readFileSync(planStatePath("card-reject-empty-feedback"), "utf8")).toBe(before);
  });

  it("approve() hitting a conflicted merge appends the conflict-marker task via reloopForConflict", async () => {
    seedCard("card-conflict");
    const planId = seedPlan("card-conflict");
    const { id: runId } = seedLoopRun("card-conflict", planId);
    seedPlanState("card-conflict");
    mocks.mergeBranch.mockResolvedValueOnce({
      ok: false,
      conflict: true,
      error: "CONFLICT (content): Merge conflict in src/feature.ts",
    });
    mocks.mergeBaseIntoWorktree.mockResolvedValueOnce({
      ok: false,
      conflicted: true,
      out: "CONFLICT (content): Merge conflict in src/feature.ts",
    });
    const deps = makeDeps();

    const result = await new ReviewService(deps).approve(runId);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("merge conflict — handed back to the loop to resolve");
    const planState = fs.readFileSync(planStatePath("card-conflict"), "utf8");
    expect(planState).toContain(
      "Follow the base-branch merge section at the top of your prompt: resolve every conflict marker while keeping both intents, then run `git diff --check` as this task's targeted verification.",
    );
    expect(deps.moveCard).toHaveBeenCalledWith("card-conflict", "reviewing", "ready", "merge conflict — resolving in loop");
    expect(deps.pump).toHaveBeenCalledTimes(1);
    expect(mocks.removeWorktree).not.toHaveBeenCalled();
    const promptMds = db
      .select()
      .from(plans)
      .where(eq(plans.cardId, "card-conflict"))
      .all()
      .map((p) => p.promptMd);
    expect(promptMds.some((p) => p.includes("## Merge conflict — resolve this first"))).toBe(true);
  });

  it("approve() hitting a clean base-branch rebase appends the rebase task, not the conflict one", async () => {
    seedCard("card-clean-rebase");
    const planId = seedPlan("card-clean-rebase");
    const { id: runId } = seedLoopRun("card-clean-rebase", planId);
    seedPlanState("card-clean-rebase");
    mocks.mergeBranch.mockResolvedValueOnce({
      ok: false,
      conflict: true,
      error: "CONFLICT (content): Merge conflict in src/feature.ts",
    });
    mocks.mergeBaseIntoWorktree.mockResolvedValueOnce({ ok: true, conflicted: false, out: "" });
    const deps = makeDeps();

    const result = await new ReviewService(deps).approve(runId);

    expect(result.ok).toBe(false);
    const planState = fs.readFileSync(planStatePath("card-clean-rebase"), "utf8");
    expect(planState).toContain(
      "Follow the base-branch merge section at the top of your prompt: confirm the implementation still applies after the clean base-branch merge, then run `git diff --check` as this task's targeted verification.",
    );
    expect(planState).not.toContain("resolve every conflict marker");
    const promptMds = db
      .select()
      .from(plans)
      .where(eq(plans.cardId, "card-clean-rebase"))
      .all()
      .map((p) => p.promptMd);
    expect(promptMds.some((p) => p.includes("## Rebased onto"))).toBe(true);
  });
});
