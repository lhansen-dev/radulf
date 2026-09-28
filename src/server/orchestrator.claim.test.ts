import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

vi.mock("./settings", async (importOriginal) => {
  // Built from the original's defaults rather than testSettings: that helper
  // loads @/server/settings, which is this very module, so importing it from
  // inside its own mock factory deadlocks. See orchestrator.roles.test.ts.
  const original = await importOriginal<typeof import("./settings")>();
  return {
    ...original,
    getSettings: () => ({
      ...original.SETTING_DEFAULTS,
      maxConcurrentCards: 1,
      autoMode: false,
      sandboxEnabled: false,
    }),
  };
});

setupTestDataDir("radulf-orchestrator-claim-");

const { db, cards, events, plans, repos, runs, workers, now } = await import("@/db");
const { Orchestrator, disposeAllOrchestrators } = await import("./orchestrator");

type Global = { __radulfOrchestrator?: unknown };

function seedReadyCard(id: string, position: number) {
  db.insert(cards)
    .values({
      id,
      repoId: "repo-1",
      title: `Card ${id}`,
      description: "Rough ask",
      status: "ready",
      position,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  db.insert(plans)
    .values({
      id: `plan-${id}`,
      cardId: id,
      version: 1,
      planMd: "## Tasks\n- [ ] one\n",
      promptMd: "p",
      acceptanceCriteria: "",
      createdAt: now(),
    })
    .run();
}

const card = (id: string) => db.select().from(cards).where(eq(cards.id, id)).get()!;

beforeEach(() => {
  db.delete(workers).run();
  db.delete(runs).run();
  db.delete(plans).run();
  db.delete(events).run();
  db.delete(cards).run();
  db.delete(repos).run();
  db.insert(repos)
    .values({ id: "repo-1", name: "Repo", path: "/tmp/repo-1", defaultBranch: "main", createdAt: now() })
    .run();
  seedReadyCard("c1", 1);
  seedReadyCard("c2", 2);
  seedReadyCard("c3", 3);
});

afterEach(() => {
  disposeAllOrchestrators();
  (globalThis as Global).__radulfOrchestrator = undefined;
});

describe("claimLoopRun", () => {
  it("claims through the database so two workers respect one repo's cap", () => {
    const a = new Orchestrator({ autoStart: false });
    const b = new Orchestrator({ autoStart: false });

    const claim = a.claimLoopRun("c1");
    expect(claim).not.toBeNull();
    expect(claim!.card.id).toBe("c1");
    expect(claim!.plan.id).toBe("plan-c1");
    expect(claim!.repo.id).toBe("repo-1");

    // Cap of one: the other worker finds no free slot.
    expect(b.claimLoopRun("c2")).toBeNull();
    // No longer ready: the same worker cannot claim it twice.
    expect(a.claimLoopRun("c1")).toBeNull();

    const runRows = db.select().from(runs).all();
    expect(runRows).toHaveLength(1);
    expect(runRows[0].id).toBe(claim!.runId);
    expect(runRows[0].cardId).toBe("c1");
    expect(runRows[0].status).toBe("running");
    expect(runRows[0].kind).toBe("loop");
    expect(runRows[0].workerId).toBe(a.workerId);

    expect(card("c1").status).toBe("looping");
    const moved = db
      .select()
      .from(events)
      .where(eq(events.type, "card.moved"))
      .all()
      .filter((e) => e.cardId === "c1")
      .map((e) => JSON.parse(e.payload ?? "{}") as { from?: string; to?: string });
    expect(moved).toContainEqual({ from: "ready", to: "looping" });

    // Once the run finishes and the card leaves the running statuses, the
    // slot frees and the other worker's claim goes through.
    db.update(runs).set({ status: "completed", endedAt: now() }).where(eq(runs.id, claim!.runId)).run();
    db.update(cards).set({ status: "done", updatedAt: now() }).where(eq(cards.id, "c1")).run();

    const second = b.claimLoopRun("c2");
    expect(second).not.toBeNull();
    const secondRow = db.select().from(runs).where(eq(runs.id, second!.runId)).get()!;
    expect(secondRow.workerId).toBe(b.workerId);
    expect(secondRow.status).toBe("running");
    expect(card("c2").status).toBe("looping");
    expect(card("c3").status).toBe("ready");
  });
});

describe("pending evaluations", () => {
  function seedCard(id: string, status: "needs_attention" | "looping", evaluationPending: 0 | 1) {
    db.insert(cards)
      .values({
        id,
        repoId: "repo-1",
        title: `Card ${id}`,
        description: "Rough ask",
        status,
        evaluationPending,
        position: 10,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    db.insert(plans)
      .values({
        id: `plan-${id}`,
        cardId: id,
        version: 1,
        planMd: "## Tasks\n- [x] one\n",
        promptMd: "p",
        acceptanceCriteria: "",
        createdAt: now(),
      })
      .run();
  }

  const movedEvents = (cardId: string) =>
    db
      .select()
      .from(events)
      .where(eq(events.type, "card.moved"))
      .all()
      .filter((e) => e.cardId === cardId)
      .map((e) => JSON.parse(e.payload ?? "{}") as { from?: string; to?: string; reason?: string });

  it("pump() claims a queued evaluation through the database once a slot frees", () => {
    db.delete(plans).run();
    db.delete(cards).run();
    seedCard("e1", "needs_attention", 1);
    seedCard("busy", "looping", 0);

    const orchestrator = new Orchestrator({ autoStart: false });
    orchestrator.pump();
    expect(card("e1").status).toBe("needs_attention");
    expect(card("e1").evaluationPending).toBe(1);

    db.update(cards).set({ status: "done", updatedAt: now() }).where(eq(cards.id, "busy")).run();
    orchestrator.pump();
    expect(card("e1").status).toBe("evaluating");
    expect(card("e1").evaluationPending).toBe(0);
    expect(movedEvents("e1")).toContainEqual({
      from: "needs_attention",
      to: "evaluating",
      reason: "queued evaluation claimed",
    });
    orchestrator.startDraining();
  });

  it("a human action out of Needs Attention clears the flag", () => {
    seedCard("e2", "needs_attention", 1);
    const orchestrator = new Orchestrator({ autoStart: false });
    orchestrator.startCard("e2");
    expect(card("e2").status).not.toBe("needs_attention");
    expect(card("e2").evaluationPending).toBe(0);
    orchestrator.startDraining();
  });
});

describe("pausing through the database", () => {
  const movedEvents = (cardId: string) =>
    db
      .select()
      .from(events)
      .where(eq(events.type, "card.moved"))
      .all()
      .filter((e) => e.cardId === cardId)
      .map((e) => JSON.parse(e.payload ?? "{}") as { from?: string; to?: string; reason?: string });

  it("pauseCard moves the card at once; resumeCard waits for the run to close", async () => {
    // Spec 25 decision 4: a pause is an immediate card transition rather
    // than an in-memory flag, so any worker sees it through the database.
    db.insert(cards)
      .values({
        id: "p1",
        repoId: "repo-1",
        title: "Card p1",
        description: "Rough ask",
        status: "looping",
        position: 10,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    db.insert(runs)
      .values({
        id: "run-p1",
        cardId: "p1",
        kind: "loop",
        status: "running",
        worktreePath: "/tmp/wt-p1",
        branch: "card/p1",
        startedAt: now(),
      })
      .run();

    const orchestrator = new Orchestrator({ autoStart: false });
    orchestrator.pauseCard("p1");
    expect(card("p1").status).toBe("paused");
    expect(movedEvents("p1")).toContainEqual({ from: "looping", to: "paused", reason: "pause requested" });

    // The loop is still banking its current iteration.
    await expect(async () => orchestrator.resumeCard("p1")).rejects.toMatchObject({
      name: "ClientError",
      status: 409,
    });
    expect(card("p1").status).toBe("paused");

    db.update(runs).set({ status: "paused", endedAt: now() }).where(eq(runs.id, "run-p1")).run();
    orchestrator.resumeCard("p1");
    expect(movedEvents("p1")).toContainEqual(expect.objectContaining({ from: "paused", to: "ready" }));
    orchestrator.startDraining();
  });
});

describe("claimStage", () => {
  function seedTodoCard(id: string, position: number) {
    db.insert(cards)
      .values({
        id,
        repoId: "repo-1",
        title: `Card ${id}`,
        description: "Rough ask",
        status: "todo",
        position,
        startedAt: now(),
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
  }

  const movedEvents = (cardId: string) =>
    db
      .select()
      .from(events)
      .where(eq(events.type, "card.moved"))
      .all()
      .filter((e) => e.cardId === cardId)
      .map((e) => JSON.parse(e.payload ?? "{}") as { from?: string; to?: string; reason?: string });

  it("two workers cannot both move a todo card into planning past the repo's cap", () => {
    seedTodoCard("t1", 20);
    seedTodoCard("t2", 21);
    const a = new Orchestrator({ autoStart: false });
    const b = new Orchestrator({ autoStart: false });

    expect(a.claimStage("t1", "todo", "planning")).toBe(true);
    expect(b.claimStage("t2", "todo", "planning")).toBe(false);
    expect(card("t1").status).toBe("planning");
    expect(card("t2").status).toBe("todo");
    expect(movedEvents("t1")).toContainEqual({ from: "todo", to: "planning" });

    db.update(cards).set({ status: "done" }).where(eq(cards.id, "t1")).run();
    expect(b.claimStage("t2", "todo", "planning")).toBe(true);
    expect(card("t2").status).toBe("planning");
  });
});
