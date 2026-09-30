import fs from "node:fs";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";
import { git, initScratchRepo } from "@/testUtils/gitRepo";

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

const testDataDir = setupTestDataDir("radulf-reviewService-");
const { loadBaseline, saveBaseline, snapshotRepoIntegrity } = await import("./integrity");

const { db, cards, plans, runs, repos, reviews, reviewDeliveries, repoLeases, refWrites, events, now } =
  await import("@/db");
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

function seedCard(id: string, status: "review" | "needs_attention" = "review") {
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
    workerId: () => "worker-test",
  };
}

describe("ReviewService — feedback re-entry", () => {
  beforeEach(() => {
    db.delete(reviews).run();
    db.delete(reviewDeliveries).run();
    db.delete(repoLeases).run();
    db.delete(refWrites).run();
    db.delete(runs).run();
    db.delete(plans).run();
    db.delete(cards).run();
    db.delete(repos).run();
    vi.clearAllMocks();
    seedRepo();
  });

  it.each(["accept", "stale config", "stale run", "hook"])("config approval: %s", async (scenario) => {
    const repoPath = initScratchRepo("radulf-config-review-");
    try {
      db.update(repos).set({ path: repoPath }).where(eq(repos.id, "repo-1")).run();
      seedCard("config-card", "needs_attention");
      const run = seedLoopRun("config-card", seedPlan("config-card"));
      const baseline = (await snapshotRepoIntegrity(repoPath))!;
      saveBaseline(run.id, baseline);
      git(repoPath, "config", "user.name", "Approved identity");
      const deps = makeDeps();
      const service = new ReviewService(deps);
      const preview = await service.reviewConfig("config-card");
      expect(preview.content).toContain("Approved identity");
      mocks.mergeBranch.mockClear();
      mocks.mergeBranch.mockResolvedValue({ ok: false, error: "delivery attempted" });

      // Ordinary retry remains blocked until an explicit config approval.
      expect(await service.retryMerge("config-card")).toMatchObject({ ok: false, error: expect.stringContaining(".git/config changed") });
      expect(mocks.mergeBranch).not.toHaveBeenCalled();

      if (scenario === "stale config") git(repoPath, "config", "user.name", "Changed again");
      if (scenario === "stale run") preview.runId = "old-run";
      if (scenario === "hook") fs.writeFileSync(path.join(repoPath, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 1\n");
      if (scenario.startsWith("stale")) {
        await expect(service.retryMerge("config-card", preview)).rejects.toThrow(/changed/);
        expect(loadBaseline(run.id)?.configHash).toBe(baseline.configHash);
        expect(mocks.mergeBranch).not.toHaveBeenCalled();
      } else {
        const result = await service.retryMerge("config-card", preview);
        expect(loadBaseline(run.id)).toEqual({ ...baseline, configHash: preview.configHash });
        if (scenario === "hook") {
          expect(result.error).toContain("hook appeared");
          expect(mocks.mergeBranch).not.toHaveBeenCalled();
        } else {
          expect(result.error).toBe("delivery attempted");
          expect(mocks.mergeBranch).toHaveBeenCalledTimes(1);
        }
      }
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
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

describe("ReviewService — spec 25 worker-side delivery", () => {
  beforeEach(() => {
    db.delete(reviews).run();
    db.delete(reviewDeliveries).run();
    db.delete(repoLeases).run();
    db.delete(refWrites).run();
    db.delete(runs).run();
    db.delete(plans).run();
    db.delete(cards).run();
    db.delete(repos).run();
    vi.clearAllMocks();
    seedRepo();
  });

  function mergeCleanly() {
    mocks.mergeBranch.mockImplementationOnce(
      async (_repo: string, _base: string, _head: string, _msg: string, onCommitted?: (sha: string) => void) => {
        onCommitted?.("abc");
        return { ok: true, mergeCommit: "abc" };
      },
    );
  }

  it("a non-passive approve runs the delivery itself under the repo lease and records the ref write", async () => {
    seedCard("card-deliver");
    const planId = seedPlan("card-deliver");
    const { id: runId } = seedLoopRun("card-deliver", planId);
    mergeCleanly();
    const deps = makeDeps();

    const result = await new ReviewService(deps).approve(runId);

    expect(result).toEqual({ ok: true });
    expect(mocks.mergeBranch).toHaveBeenCalledTimes(1);
    const deliveries = db.select().from(reviewDeliveries).where(eq(reviewDeliveries.runId, runId)).all();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ status: "finished", ok: 1, workerId: "worker-test", error: null });
    expect(db.select().from(repoLeases).all()).toEqual([]);
    const writes = db.select().from(refWrites).where(eq(refWrites.ref, "refs/heads/main")).all();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ sha: "abc", workerId: "worker-test" });
    expect(deps.moveCard).toHaveBeenCalledWith("card-deliver", "reviewing", "done");
  });

  it("an already-landed merge is recorded, not redone: alreadyMerged reaches review.decided and completeApproval still runs", async () => {
    seedCard("card-landed");
    const planId = seedPlan("card-landed");
    const { id: runId } = seedLoopRun("card-landed", planId);
    // A dead worker already committed the merge; mergeBranch reports it
    // without invoking onCommitted, so no ref write is recorded now.
    mocks.mergeBranch.mockResolvedValueOnce({ ok: true, mergeCommit: "abc", alreadyMerged: true });
    const deps = makeDeps();

    const result = await new ReviewService(deps).approve(runId);

    expect(result).toEqual({ ok: true });
    expect(deps.moveCard).toHaveBeenCalledWith("card-landed", "reviewing", "done");
    expect(mocks.removeWorktree).toHaveBeenCalledTimes(1);
    const review = db.select().from(reviews).where(eq(reviews.runId, runId)).get();
    expect(review).toMatchObject({ decision: "approved", mergeCommit: "abc" });
    expect(db.select().from(refWrites).all()).toEqual([]);
    const decided = db
      .select()
      .from(events)
      .where(and(eq(events.cardId, "card-landed"), eq(events.type, "review.decided")))
      .orderBy(desc(events.id))
      .get();
    expect(decided).toBeDefined();
    expect(JSON.parse(decided!.payload)).toMatchObject({ decision: "approved", mergeCommit: "abc", alreadyMerged: true });
  });

  it("a passive approve only enqueues the delivery; claimPendingDeliveries() on a worker runs it", async () => {
    seedCard("card-passive");
    const planId = seedPlan("card-passive");
    const { id: runId } = seedLoopRun("card-passive", planId);
    const webDeps = { ...makeDeps(), passive: () => true };

    const result = await new ReviewService(webDeps).approve(runId);

    expect(result).toEqual({ ok: true });
    expect(mocks.mergeBranch).not.toHaveBeenCalled();
    expect(webDeps.moveCard).toHaveBeenCalledWith("card-passive", "review", "reviewing");
    expect(webDeps.moveCard).not.toHaveBeenCalledWith("card-passive", "reviewing", "done");
    const pending = db.select().from(reviewDeliveries).where(eq(reviewDeliveries.runId, runId)).get();
    expect(pending).toMatchObject({ status: "pending", workerId: null, fromStatus: "review", approvedBy: "human" });

    mergeCleanly();
    const workerDeps = makeDeps();
    new ReviewService(workerDeps).claimPendingDeliveries();

    await vi.waitFor(() => {
      const row = db.select().from(reviewDeliveries).where(eq(reviewDeliveries.id, pending!.id)).get();
      expect(row?.status).toBe("finished");
    });
    const finished = db.select().from(reviewDeliveries).where(eq(reviewDeliveries.id, pending!.id)).get();
    expect(finished).toMatchObject({ ok: 1, workerId: "worker-test" });
    expect(mocks.mergeBranch).toHaveBeenCalledTimes(1);
    expect(workerDeps.moveCard).toHaveBeenCalledWith("card-passive", "reviewing", "done");
    expect(db.select().from(repoLeases).all()).toEqual([]);
    expect(db.select().from(refWrites).where(eq(refWrites.ref, "refs/heads/main")).all()).toHaveLength(1);
  });

  it("a pending delivery whose repo record vanished is finished as failed and its card parked", () => {
    seedCard("card-gone");
    const planId = seedPlan("card-gone");
    const { id: runId } = seedLoopRun("card-gone", planId);
    db.insert(reviewDeliveries)
      .values({
        id: "delivery-gone",
        runId,
        cardId: "card-gone",
        repoId: "repo-gone",
        fromStatus: "review",
        approvedBy: "human",
        status: "pending",
        createdAt: now(),
      })
      .run();
    const deps = makeDeps();

    new ReviewService(deps).claimPendingDeliveries();

    const row = db.select().from(reviewDeliveries).where(eq(reviewDeliveries.id, "delivery-gone")).get();
    expect(row).toMatchObject({ status: "finished", ok: 0 });
    expect(row?.error).not.toBeNull();
    expect(deps.moveCard).toHaveBeenCalledWith("card-gone", "reviewing", "needs_attention", expect.any(String));
    expect(mocks.mergeBranch).not.toHaveBeenCalled();
    expect(db.select().from(repoLeases).all()).toEqual([]);
  });
});

describe("ReviewService — abandon", () => {
  beforeEach(() => {
    db.delete(reviews).run();
    db.delete(reviewDeliveries).run();
    db.delete(runs).run();
    db.delete(plans).run();
    db.delete(cards).run();
    db.delete(repos).run();
    vi.clearAllMocks();
    seedRepo();
  });

  it("a worker removes the worktree and the plan state", async () => {
    seedCard("card-abandon");
    const { worktreePath } = seedLoopRun("card-abandon", seedPlan("card-abandon"));
    seedPlanState("card-abandon");
    const deps = makeDeps();

    await new ReviewService(deps).abandon("card-abandon");

    expect(deps.moveCard).toHaveBeenCalledWith("card-abandon", "review", "abandoned");
    expect(mocks.removeWorktree).toHaveBeenCalledWith(path.join(testDataDir, "repo"), worktreePath, "ralph/loop-card-abandon");
    expect(fs.existsSync(planStatePath("card-abandon"))).toBe(false);
  });

  // Spec 25: web never writes to a repository. The worktree waits for a
  // worker's removeFinishedWorktrees sweep (retention.ts).
  it("a passive (web) abandon moves the card but leaves the repository alone", async () => {
    seedCard("card-abandon-web");
    seedLoopRun("card-abandon-web", seedPlan("card-abandon-web"));
    seedPlanState("card-abandon-web");
    const deps = { ...makeDeps(), passive: () => true };

    await new ReviewService(deps).abandon("card-abandon-web");

    expect(deps.moveCard).toHaveBeenCalledWith("card-abandon-web", "review", "abandoned");
    expect(mocks.removeWorktree).not.toHaveBeenCalled();
    expect(fs.existsSync(planStatePath("card-abandon-web"))).toBe(false);
  });
});
