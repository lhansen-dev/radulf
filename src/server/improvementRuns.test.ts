import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

const mocks = vi.hoisted(() => ({
  startCard: vi.fn(),
  proposeOneImprovement: vi.fn(),
  git: vi.fn(),
  assertBranchExists: vi.fn(),
}));

vi.mock("./orchestrator", () => ({ getOrchestrator: () => ({ startCard: mocks.startCard }) }));
vi.mock("./improvementProposer", () => ({ proposeOneImprovement: mocks.proposeOneImprovement }));
vi.mock("./git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./git")>()),
  git: mocks.git,
  assertBranchExists: mocks.assertBranchExists,
}));

setupTestDataDir("radulf-improvement-runs-");

const { db, cards, repos, improvementRuns, events, now } = await import("@/db");
const { emitEvent } = await import("./events");
const {
  createImprovementRun,
  driveRun,
  stopImprovementRun,
  awaitCardTerminal,
} = await import("./improvementRuns");

function insertRepo(id = "repo-1") {
  db.insert(repos)
    .values({ id, name: id, path: `/tmp/${id}`, defaultBranch: "main", createdAt: now() })
    .run();
}

function insertCard(id: string, status: "needs_attention" | "todo" = "todo") {
  db.insert(cards)
    .values({
      id,
      repoId: "repo-1",
      title: `Card ${id}`,
      description: "",
      status,
      position: 1,
      source: "agent",
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
}

function insertRun(overrides: Partial<typeof improvementRuns.$inferInsert> & { id: string }) {
  db.insert(improvementRuns)
    .values({
      repoId: "repo-1",
      status: "running",
      featureBranch: "ralph/improve-test",
      baseBranch: "main",
      deadlineAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      createdAt: now(),
      updatedAt: now(),
      ...overrides,
    })
    .run();
  return overrides.id;
}

function getRunRow(id: string) {
  return db.select().from(improvementRuns).where(eq(improvementRuns.id, id)).get()!;
}

function resolveCardAs(cardId: string, status: "done" | "needs_attention" | "backlog") {
  db.update(cards).set({ status, updatedAt: now() }).where(eq(cards.id, cardId)).run();
  emitEvent("card.moved", { cardId, payload: { to: status } });
}

beforeEach(() => {
  db.delete(cards).run();
  db.delete(improvementRuns).run();
  db.delete(repos).run();
  db.delete(events).run();
  vi.clearAllMocks();
  mocks.assertBranchExists.mockResolvedValue(undefined);
  mocks.git.mockResolvedValue("");
  insertRepo();
});

describe("awaitCardTerminal", () => {
  it("resolves once the card reaches a terminal status", async () => {
    insertCard("term-card", "todo");
    const pending = awaitCardTerminal("term-card", 50);
    resolveCardAs("term-card", "done");
    await expect(pending).resolves.toBe("done");
  });

  it("resolves once the card is cancelled back to backlog", async () => {
    insertCard("cancelled-card", "todo");
    const pending = awaitCardTerminal("cancelled-card", 50);
    resolveCardAs("cancelled-card", "backlog");
    await expect(pending).resolves.toBe("backlog");
  });

  // Card deletion (the API route's DELETE handler) emits no bus event, so
  // only the periodic poll can notice the card is gone — this is the case
  // the `pollMs` parameter exists to exercise.
  it("resolves with null once the card is deleted", async () => {
    insertCard("deleted-card", "todo");
    const pending = awaitCardTerminal("deleted-card", 50);
    db.delete(cards).where(eq(cards.id, "deleted-card")).run();
    await expect(pending).resolves.toBeNull();
  });
});

describe("driveRun", () => {
  it("does not create a new task once the deadline has already passed", async () => {
    const runId = insertRun({
      id: "run-deadline",
      deadlineAt: new Date(Date.now() - 1000).toISOString(),
    });

    await driveRun(runId);

    expect(mocks.proposeOneImprovement).not.toHaveBeenCalled();
    expect(mocks.startCard).not.toHaveBeenCalled();
    const run = getRunRow(runId);
    expect(run.status).toBe("completed");
    expect(run.endedAt).not.toBeNull();
    expect(run.tasksCreated).toBe(0);
  });

  // Regression: `run` is loaded before the proposer pass, which takes minutes.
  // A Stop landing in that window only moves `deadlineAt` in the DB, so reading
  // the budget off the stale snapshot spawned a whole extra card 6.5 minutes
  // after an observed live run had already been stopped.
  it("honours a Stop that lands while the proposer pass is still running", async () => {
    const runId = insertRun({ id: "run-stop-midpass" });
    mocks.proposeOneImprovement.mockImplementation(async () => {
      // The Stop arrives mid-pass, exactly as an operator's click would.
      stopImprovementRun(runId);
      return { title: "Too late", description: "d", rationale: "r" };
    });

    await driveRun(runId);

    expect(mocks.proposeOneImprovement).toHaveBeenCalledTimes(1);
    expect(mocks.startCard).not.toHaveBeenCalled();
    const run = getRunRow(runId);
    expect(run.tasksCreated).toBe(0);
    expect(run.status).toBe("stopped");
    expect(db.select().from(cards).all()).toHaveLength(0);
  });

  it("stops after 3 consecutive failures, and a success in between resets the streak", async () => {
    const runId = insertRun({ id: "run-failures" });
    const outcomes: Array<"done" | "needs_attention"> = [
      "needs_attention",
      "needs_attention",
      "done",
      "needs_attention",
      "needs_attention",
      "needs_attention",
    ];
    let n = 0;
    mocks.proposeOneImprovement.mockImplementation(async () => ({
      title: `Improvement ${n++}`,
      description: "d",
      rationale: "r",
    }));
    mocks.startCard.mockImplementation((cardId: string) => {
      resolveCardAs(cardId, outcomes.shift()!);
    });

    await driveRun(runId);

    expect(mocks.startCard).toHaveBeenCalledTimes(6);
    const run = getRunRow(runId);
    expect(run.status).toBe("failed");
    expect(run.tasksCreated).toBe(6);
    expect(run.tasksSucceeded).toBe(1);
    expect(run.consecutiveFailures).toBe(3);
  });

  // Regression: cancelling a card (orchestrator.cancelCard) parks it in
  // "backlog", which wasn't a terminal status — the driver awaited it forever,
  // wedging the run and blocking Stop, which only moves the deadline the
  // (unreachable) top of the loop would need to check.
  it("proceeds past a card cancelled to backlog, recorded as not-succeeded", async () => {
    const runId = insertRun({ id: "run-cancelled" });
    mocks.proposeOneImprovement.mockResolvedValue({
      title: "Improvement",
      description: "d",
      rationale: "r",
    });
    mocks.startCard.mockImplementation((cardId: string) => {
      resolveCardAs(cardId, "backlog");
      // Stand in for the deadline having elapsed by the time the loop comes
      // back around, so the run ends after this one card instead of looping
      // forever on the mocked proposer.
      stopImprovementRun(runId);
    });

    await driveRun(runId);

    expect(mocks.startCard).toHaveBeenCalledTimes(1);
    const run = getRunRow(runId);
    expect(run.tasksCreated).toBe(1);
    expect(run.tasksSucceeded).toBe(0);
    expect(run.consecutiveFailures).toBe(1);
    expect(run.status).toBe("stopped");
  });

  // Regression: same wedge as above, but for a card deleted out from under
  // the driver instead of cancelled.
  it("proceeds past a card deleted mid-flight, recorded as not-succeeded", async () => {
    const runId = insertRun({ id: "run-deleted" });
    mocks.proposeOneImprovement.mockResolvedValue({
      title: "Improvement",
      description: "d",
      rationale: "r",
    });
    mocks.startCard.mockImplementation((cardId: string) => {
      db.delete(cards).where(eq(cards.id, cardId)).run();
      stopImprovementRun(runId);
    });

    await driveRun(runId);

    expect(mocks.startCard).toHaveBeenCalledTimes(1);
    const run = getRunRow(runId);
    expect(run.tasksCreated).toBe(1);
    expect(run.tasksSucceeded).toBe(0);
    expect(run.consecutiveFailures).toBe(1);
    expect(run.status).toBe("stopped");
  });

  it("reconciles an interrupted in-flight card as a failure on resume", async () => {
    // Simulates a server restart: orchestrator.recover() already flipped the
    // orphaned card to needs_attention before the driver ever sees it again.
    insertCard("interrupted-card", "needs_attention");
    const runId = insertRun({
      id: "run-resume",
      currentCardId: "interrupted-card",
      deadlineAt: new Date(Date.now() - 1000).toISOString(),
    });

    await driveRun(runId);

    expect(mocks.startCard).not.toHaveBeenCalled();
    const run = getRunRow(runId);
    expect(run.currentCardId).toBeNull();
    expect(run.consecutiveFailures).toBe(1);
    expect(run.tasksSucceeded).toBe(0);
    // No 3rd consecutive failure here, so the run only ends because the
    // (already-past) deadline is checked right after reconciling.
    expect(run.status).toBe("completed");
  });
});

describe("createImprovementRun", () => {
  it("rejects when the repo already has an active run", async () => {
    insertRun({ id: "run-active" });

    await expect(
      createImprovementRun({ repoId: "repo-1", baseBranch: "main", budgetMinutes: 30 }),
    ).rejects.toThrow(/already active/);
  });

  it("refuses a ralph/* base branch, as card creation does", async () => {
    await expect(
      createImprovementRun({ repoId: "repo-1", baseBranch: "ralph/improve-1700000000000", budgetMinutes: 30 }),
    ).rejects.toThrow(/ralph\//);

    expect(mocks.git).not.toHaveBeenCalled();
    expect(db.select().from(improvementRuns).all()).toHaveLength(0);
  });

  it("cuts a feature branch off baseBranch and persists the run", async () => {
    const row = await createImprovementRun({
      repoId: "repo-1",
      baseBranch: "main",
      budgetMinutes: 45,
    });
    // The creation call fires off a background driver (fire-and-forget) —
    // neutralize it immediately so it doesn't linger past this test.
    db.update(improvementRuns)
      .set({ status: "stopped", endedAt: now() })
      .where(eq(improvementRuns.id, row.id))
      .run();

    expect(row.status).toBe("running");
    expect(row.featureBranch).toMatch(/^ralph\/improve-\d+$/);
    expect(mocks.git).toHaveBeenCalledWith("/tmp/repo-1", "branch", row.featureBranch, "main");
    expect(Date.parse(row.deadlineAt)).toBeGreaterThan(Date.now() + 44 * 60_000);
  });
});

describe("stopImprovementRun", () => {
  it("moves the deadline to now without changing status", () => {
    const runId = insertRun({ id: "run-stop" });
    const before = getRunRow(runId).deadlineAt;

    const updated = stopImprovementRun(runId);

    expect(updated.status).toBe("running");
    expect(Date.parse(updated.deadlineAt)).toBeLessThanOrEqual(Date.parse(before));
  });
});
