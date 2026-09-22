import fs from "node:fs";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

// Spec 15 acceptance tests: delivering an approved diff as a GitHub pull
// request instead of merging it into the local base branch. The git and gh
// boundaries are mocked — what is under test is the decision and the ordering
// around them, not git's or gh's own behavior.

const mocks = vi.hoisted(() => ({
  mergeBranch: vi.fn(),
  mergeBaseIntoWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  hasRemote: vi.fn(),
  pushBranch: vi.fn(),
  stripRalphForDelivery: vi.fn(),
  githubStatus: vi.fn(),
  createPullRequest: vi.fn(),
  invalidateGithubStatus: vi.fn(),
  settings: { openPr: false, autoApprove: false },
}));

vi.mock("./git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./git")>()),
  mergeBranch: mocks.mergeBranch,
  mergeBaseIntoWorktree: mocks.mergeBaseIntoWorktree,
  removeWorktree: mocks.removeWorktree,
  hasRemote: mocks.hasRemote,
  pushBranch: mocks.pushBranch,
  stripRalphForDelivery: mocks.stripRalphForDelivery,
}));
vi.mock("./github", () => ({
  githubStatus: mocks.githubStatus,
  createPullRequest: mocks.createPullRequest,
  invalidateGithubStatus: mocks.invalidateGithubStatus,
}));
vi.mock("./settings", () => ({ getSettings: () => mocks.settings }));

const testDataDir = setupTestDataDir("radulf-reviewService-pr-");

const { db, cards, improvementRuns, plans, runs, repos, reviews, events, now } =
  await import("@/db");
const { ReviewService } = await import("./reviewService");

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

function seedCard(id: string, openPr: 0 | 1) {
  db.insert(cards)
    .values({
      id,
      repoId: "repo-1",
      title: `Card ${id}`,
      description: "PR delivery test card",
      status: "review",
      position: 1,
      openPr,
      summary: "The evaluator's summary of the change.",
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

function seedRun(cardId: string) {
  const planId = `plan-${cardId}`;
  db.insert(plans)
    .values({
      id: planId,
      cardId,
      version: 1,
      planMd: "## Tasks\n- [ ] implement the thing\n",
      promptMd: "Implement the thing.",
      acceptanceCriteria: "The thing is implemented.",
      createdAt: now(),
    })
    .run();
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

function decision(cardId: string): Record<string, unknown> | undefined {
  const row = db
    .select()
    .from(events)
    .where(and(eq(events.cardId, cardId), eq(events.type, "review.decided")))
    .orderBy(desc(events.id))
    .get();
  return row ? (JSON.parse(row.payload) as Record<string, unknown>) : undefined;
}

describe("ReviewService — spec 15 pull-request delivery", () => {
  beforeEach(() => {
    db.delete(events).run();
    db.delete(improvementRuns).run();
    db.delete(reviews).run();
    db.delete(runs).run();
    db.delete(plans).run();
    db.delete(cards).run();
    db.delete(repos).run();
    vi.clearAllMocks();
    mocks.settings.openPr = false;
    mocks.settings.autoApprove = false;
    mocks.mergeBranch.mockResolvedValue({ ok: true, mergeCommit: "abc123" });
    mocks.mergeBaseIntoWorktree.mockResolvedValue({ ok: true, conflicted: false, out: "" });
    mocks.removeWorktree.mockResolvedValue(undefined);
    mocks.hasRemote.mockResolvedValue(true);
    mocks.pushBranch.mockResolvedValue({ ok: true });
    mocks.stripRalphForDelivery.mockResolvedValue({ ok: true, out: "" });
    mocks.githubStatus.mockResolvedValue({ ok: true });
    mocks.createPullRequest.mockResolvedValue({
      ok: true,
      url: "https://github.com/o/r/pull/7",
    });
    seedRepo();
  });

  it("1 — delivers by local merge and spawns no gh when PR delivery is off", async () => {
    seedCard("card-merge", 0);
    const run = seedRun("card-merge");

    const result = await new ReviewService(makeDeps()).approve(run.id);

    expect(result.ok).toBe(true);
    expect(mocks.mergeBranch).toHaveBeenCalledTimes(1);
    expect(mocks.pushBranch).not.toHaveBeenCalled();
    expect(mocks.createPullRequest).not.toHaveBeenCalled();
  });

  it("2 — pushes and opens a PR without merging locally", async () => {
    seedCard("card-pr", 1);
    const run = seedRun("card-pr");

    const result = await new ReviewService(makeDeps()).approve(run.id);

    expect(result.ok).toBe(true);
    expect(mocks.mergeBranch).not.toHaveBeenCalled();
    expect(mocks.pushBranch).toHaveBeenCalledWith(run.worktreePath, "ralph/loop-card-pr");
    expect(mocks.createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ baseBranch: "main", branch: "ralph/loop-card-pr" }),
    );
    expect(decision("card-pr")).toMatchObject({
      delivery: "pr",
      prUrl: "https://github.com/o/r/pull/7",
    });
  });

  it("3 — the global setting grants delivery, and the event records which did", async () => {
    mocks.settings.openPr = true;
    seedCard("card-global", 0);
    const runGlobal = seedRun("card-global");
    await new ReviewService(makeDeps()).approve(runGlobal.id);
    expect(decision("card-global")).toMatchObject({ delivery: "pr", grantedBy: "global" });

    mocks.settings.openPr = false;
    seedCard("card-flag", 1);
    const runFlag = seedRun("card-flag");
    await new ReviewService(makeDeps()).approve(runFlag.id);
    expect(decision("card-flag")).toMatchObject({ delivery: "pr", grantedBy: "card" });
  });

  it("4 — a human approval opens a real PR, an auto-approved one opens a draft", async () => {
    seedCard("card-human", 1);
    const human = seedRun("card-human");
    await new ReviewService(makeDeps()).approve(human.id, "human");
    expect(mocks.createPullRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ draft: false }),
    );

    seedCard("card-auto", 1);
    const auto = seedRun("card-auto");
    await new ReviewService(makeDeps()).approve(auto.id, "auto");
    expect(mocks.createPullRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ draft: true }),
    );
  });

  it("5 — merges the base branch in before pushing, and hands a conflict back to the loop", async () => {
    seedCard("card-conflict", 1);
    const run = seedRun("card-conflict");
    mocks.mergeBaseIntoWorktree.mockResolvedValue({
      ok: false,
      conflicted: true,
      out: "CONFLICT (content): both modified src/a.ts",
    });
    const deps = makeDeps();

    const result = await new ReviewService(deps).approve(run.id);

    expect(result.ok).toBe(false);
    expect(mocks.pushBranch).not.toHaveBeenCalled();
    expect(mocks.createPullRequest).not.toHaveBeenCalled();
    // Handed back for resolution rather than dead-ended, and — the point of
    // passing the merge result through — without a second merge attempt on a
    // worktree that already holds conflict markers.
    expect(mocks.mergeBaseIntoWorktree).toHaveBeenCalledTimes(1);
    expect(deps.moveCard).toHaveBeenLastCalledWith(
      "card-conflict",
      "reviewing",
      "ready",
      expect.stringContaining("merge conflict"),
    );
  });

  it("5b — strips .ralph after the base merge and before the push", async () => {
    seedCard("card-order", 1);
    const run = seedRun("card-order");
    const order: string[] = [];
    mocks.mergeBaseIntoWorktree.mockImplementation(async () => {
      order.push("merge-base");
      return { ok: true, conflicted: false, out: "" };
    });
    mocks.stripRalphForDelivery.mockImplementation(async () => {
      order.push("strip");
      return { ok: true, out: "" };
    });
    mocks.pushBranch.mockImplementation(async () => {
      order.push("push");
      return { ok: true };
    });

    await new ReviewService(makeDeps()).approve(run.id);

    // .ralph is excluded from every review surface, so a push that carried it
    // would publish content no human was shown; stripping after the base merge
    // keeps a hand-back to the loop from ever seeing stripped loop memory.
    expect(order).toEqual(["merge-base", "strip", "push"]);
  });

  it("6 — a failed push never falls back to merging, and leaves the card recoverable", async () => {
    seedCard("card-push-fail", 1);
    const run = seedRun("card-push-fail");
    mocks.pushBranch.mockResolvedValue({ ok: false, error: "rejected: non-fast-forward" });
    const deps = makeDeps();

    const result = await new ReviewService(deps).approve(run.id);

    expect(result.ok).toBe(false);
    expect(mocks.mergeBranch).not.toHaveBeenCalled();
    expect(mocks.removeWorktree).not.toHaveBeenCalled();
    expect(deps.moveCard).toHaveBeenLastCalledWith(
      "card-push-fail",
      "reviewing",
      "needs_attention",
      expect.stringContaining("non-fast-forward"),
    );
    expect(decision("card-push-fail")).toMatchObject({ delivery: "pr" });
  });

  it("6b — a failed gh pr create does not merge either", async () => {
    seedCard("card-gh-fail", 1);
    const run = seedRun("card-gh-fail");
    mocks.createPullRequest.mockResolvedValue({ ok: false, error: "no default branch" });

    const result = await new ReviewService(makeDeps()).approve(run.id);

    expect(result.ok).toBe(false);
    expect(mocks.mergeBranch).not.toHaveBeenCalled();
    expect(db.select().from(reviews).all()).toHaveLength(0);
  });

  it("never applies the workspace toggle to an Improvement Run's own cards", async () => {
    // Improvement Runs accumulate by merging each approved card into a local
    // `ralph/improve-*` branch. That branch is not on any remote, so PR
    // delivery would not merely change the shape of the result — it would
    // break the run.
    mocks.settings.openPr = true;
    db.insert(improvementRuns)
      .values({
        id: "run-1",
        repoId: "repo-1",
        featureBranch: "ralph/improve-123",
        baseBranch: "main",
        deadlineAt: now(),
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    seedCard("card-improve", 0);
    const run = seedRun("card-improve");
    db.update(runs).set({ baseBranch: "ralph/improve-123" }).where(eq(runs.id, run.id)).run();

    const result = await new ReviewService(makeDeps()).approve(run.id);

    expect(result.ok).toBe(true);
    expect(mocks.mergeBranch).toHaveBeenCalledTimes(1);
    expect(mocks.pushBranch).not.toHaveBeenCalled();
    expect(mocks.createPullRequest).not.toHaveBeenCalled();
  });

  it("7 — unmet preconditions leave the card in review, not needs_attention", async () => {
    for (const [id, arrange, expected] of [
      [
        "card-no-gh",
        () => mocks.githubStatus.mockResolvedValue({ ok: false, reason: "missing", detail: "the GitHub CLI (`gh`) is not installed or not on PATH" }),
        "not installed",
      ],
      [
        "card-no-auth",
        () => mocks.githubStatus.mockResolvedValue({ ok: false, reason: "unauthenticated", detail: "`gh` is not authenticated — run `gh auth login` in a terminal" }),
        "not authenticated",
      ],
      ["card-no-remote", () => mocks.hasRemote.mockResolvedValue(false), "no `origin`"],
    ] as [string, () => void, string][]) {
      // Reset both preconditions each round: each case must fail for its own
      // reason, not for the previous case's.
      mocks.githubStatus.mockResolvedValue({ ok: true });
      mocks.hasRemote.mockResolvedValue(true);
      arrange();
      seedCard(id, 1);
      const run = seedRun(id);
      const deps = makeDeps();

      const result = await new ReviewService(deps).approve(run.id);

      expect(result.ok).toBe(false);
      expect(result.error).toContain(expected);
      // Back to review, so the Approve button the operator just used is still
      // there once they have fixed the precondition outside Radulf.
      expect(deps.moveCard).toHaveBeenLastCalledWith(id, "reviewing", "review", expect.any(String));
      expect(mocks.pushBranch).not.toHaveBeenCalled();
    }
  });
});
