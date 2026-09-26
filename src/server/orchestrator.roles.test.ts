import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

vi.mock("./settings", async (importOriginal) => {
  // Built from the original's defaults rather than testSettings: that helper
  // loads @/server/settings, which is this very module, so importing it from
  // inside its own mock factory deadlocks. See orchestrator.scoping.test.ts.
  const original = await importOriginal<typeof import("./settings")>();
  return {
    ...original,
    // autoMode off: an active pump() must not reach for a real planner
    // harness in the control cases below.
    getSettings: () => ({ ...original.SETTING_DEFAULTS, autoMode: false, sandboxEnabled: false }),
  };
});

setupTestDataDir("radulf-orchestrator-roles-");

const { db, cards, events, iterations, plans, repos, runs, workers, now } = await import("@/db");
const { Orchestrator, disposeAllOrchestrators, getOrchestrator } = await import("./orchestrator");

type Global = { __radulfOrchestrator?: unknown };

function seedCard(id: string, overrides: Partial<typeof cards.$inferInsert> = {}) {
  db.insert(cards)
    .values({
      id,
      repoId: "repo-1",
      title: `Card ${id}`,
      description: "Rough ask",
      status: "backlog",
      position: 1,
      createdAt: now(),
      updatedAt: now(),
      ...overrides,
    })
    .run();
}

function seedRun(id: string, cardId: string, overrides: Partial<typeof runs.$inferInsert> = {}) {
  db.insert(runs)
    .values({
      id,
      cardId,
      kind: "loop",
      status: "running",
      worktreePath: "/tmp/wt",
      branch: "ralph/x",
      startedAt: now(),
      ...overrides,
    })
    .run();
}

const card = (id: string) => db.select().from(cards).where(eq(cards.id, id)).get()!;
const run = (id: string) => db.select().from(runs).where(eq(runs.id, id)).get()!;
const runsFor = (cardId: string) => db.select().from(runs).where(eq(runs.cardId, cardId)).all();

const originalRoles = process.env.RADULF_ROLES;

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
});

afterEach(() => {
  disposeAllOrchestrators();
  (globalThis as Global).__radulfOrchestrator = undefined;
  if (originalRoles === undefined) delete process.env.RADULF_ROLES;
  else process.env.RADULF_ROLES = originalRoles;
});

describe("passive orchestrator (web role only)", () => {
  it("does not run boot recovery when constructed", () => {
    seedCard("c1", { status: "looping" });
    seedRun("r1", "c1");

    new Orchestrator({ passive: true });

    expect(run("r1").status).toBe("running");
    expect(card("c1").status).toBe("looping");
  });

  it("queueCard moves backlog to todo and starts nothing", () => {
    seedCard("c1", { status: "backlog" });

    new Orchestrator({ passive: true }).queueCard("c1");

    expect(card("c1").status).toBe("todo");
    expect(runsFor("c1")).toHaveLength(0);
  });

  it("startCard leaves a todo card in todo with startedAt stamped for the worker", () => {
    seedCard("c1", { status: "todo" });

    new Orchestrator({ passive: true }).startCard("c1");

    const after = card("c1");
    expect(after.status).toBe("todo");
    expect(after.startedAt).not.toBeNull();
    expect(runsFor("c1")).toHaveLength(0);
  });

  it("startCard on an unplanned needs_attention card lands it in todo", () => {
    seedCard("c1", { status: "needs_attention" });

    new Orchestrator({ passive: true }).startCard("c1");

    expect(card("c1").status).toBe("todo");
    expect(runsFor("c1")).toHaveLength(0);
  });

  it("pump() is a no-op", () => {
    seedCard("c1", { status: "ready" });

    new Orchestrator({ passive: true }).pump();

    expect(card("c1").status).toBe("ready");
    expect(runsFor("c1")).toHaveLength(0);
  });

  it("retryFailedStep on a failed planner lands the card in todo for the worker", () => {
    seedCard("c1", { status: "needs_attention", startedAt: now() });
    seedRun("r1", "c1", { kind: "plan", status: "failed", startedAt: now(), endedAt: now() });

    expect(new Orchestrator({ passive: true }).retryFailedStep("c1")).toEqual({ ok: true, step: "plan" });

    expect(card("c1").status).toBe("todo");
    expect(runsFor("c1")).toHaveLength(1);
  });

  it("retryFailedStep on a failed evaluator flags the card for a worker's pump", () => {
    seedCard("c1", { status: "needs_attention" });
    seedRun("r1", "c1", { kind: "evaluate", status: "failed", startedAt: now(), endedAt: now() });

    expect(new Orchestrator({ passive: true }).retryFailedStep("c1")).toEqual({ ok: true, step: "evaluate" });

    const after = card("c1");
    expect(after.status).toBe("needs_attention");
    expect(after.evaluationPending).toBe(1);
    expect(runsFor("c1")).toHaveLength(1);
    const queued = db.select().from(events).where(eq(events.type, "card.evaluation_queued")).all();
    expect(queued).toHaveLength(1);
    expect(JSON.parse(queued[0].payload ?? "{}")).toEqual({ reason: "retrying failed evaluator" });
  });

  it("retryFailedStep still refuses a plan-critic retry with 409", () => {
    seedCard("c1", { status: "needs_attention" });
    seedRun("r1", "c1", { kind: "critique", status: "failed", startedAt: now(), endedAt: now() });

    let caught: unknown;
    try {
      new Orchestrator({ passive: true }).retryFailedStep("c1");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as { status?: number }).status).toBe(409);
    expect(card("c1").status).toBe("needs_attention");
  });
});

describe("operator verbs from a web-only process write runs.control", () => {
  const finishedEvents = (runId: string) =>
    db
      .select()
      .from(events)
      .where(eq(events.runId, runId))
      .all()
      .filter((e) => e.type === "run.finished");

  it("cancelCard finishes the run, moves the card and asks the owning worker to abort", () => {
    seedCard("c1", { status: "looping" });
    seedRun("r1", "c1");

    new Orchestrator({ passive: true }).cancelCard("c1");

    expect(run("r1")).toMatchObject({
      status: "cancelled",
      exitReason: "cancelled by user",
      control: "cancel",
    });
    expect(card("c1").status).toBe("backlog");
    expect(finishedEvents("r1")).toHaveLength(1);
  });

  it("pauseCard moves the card at once and leaves the run to close at the worker's boundary", () => {
    seedCard("c2", { status: "looping" });
    seedRun("r2", "c2");

    new Orchestrator({ passive: true }).pauseCard("c2");

    expect(card("c2").status).toBe("paused");
    expect(run("r2")).toMatchObject({ status: "running", control: "pause" });
  });

  it("cancelCard leaves a run that already finished on its own untouched", () => {
    seedCard("c3", { status: "looping" });
    seedRun("r3", "c3", { status: "completed", endedAt: now() });

    new Orchestrator({ passive: true }).cancelCard("c3");

    expect(run("r3").status).toBe("completed");
    expect(run("r3").control).toBeNull();
    expect(finishedEvents("r3")).toHaveLength(0);
  });

  it("cancelCard does not fail iterations or write control when a peer finished the run first", () => {
    seedCard("c4", { status: "looping" });
    seedRun("r4", "c4");
    db.insert(iterations)
      .values({ id: 4, runId: "r4", n: 1, status: "running", transcriptPath: "iter-001.jsonl", startedAt: now() })
      .run();
    const orch = new Orchestrator({ passive: true });
    vi.spyOn(orch as unknown as { finishRun: () => boolean }, "finishRun").mockReturnValue(false);

    orch.cancelCard("c4");

    expect(db.select().from(iterations).where(eq(iterations.id, 4)).get()!.status).toBe("running");
    expect(run("r4").control).toBeNull();
    expect(card("c4").status).toBe("backlog");
  });
});

describe("worker registration", () => {
  it("a passive orchestrator registers a workers row with the web role", () => {
    const orchestrator = new Orchestrator({ passive: true });

    const rows = db.select().from(workers).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(orchestrator.workerId);
    expect(rows[0].roles).toBe(JSON.stringify(["web"]));
  });

  it("a non-passive orchestrator registers a workers row with the worker role", () => {
    const orchestrator = new Orchestrator({ autoStart: false });

    const rows = db.select().from(workers).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(orchestrator.workerId);
    expect(rows[0].roles).toBe(JSON.stringify(["worker"]));
  });
});

describe("getOrchestrator", () => {
  it("is passive when RADULF_ROLES is web", () => {
    process.env.RADULF_ROLES = "web";
    (globalThis as Global).__radulfOrchestrator = undefined;
    seedCard("c1", { status: "looping" });
    seedRun("r1", "c1");
    seedCard("c2", { status: "ready", position: 2 });

    const orchestrator = getOrchestrator();
    orchestrator.pump();

    expect(run("r1").status).toBe("running");
    expect(card("c2").status).toBe("ready");
    expect(runsFor("c2")).toHaveLength(0);
  });

  it("runs boot recovery when RADULF_ROLES is unset (both roles)", () => {
    delete process.env.RADULF_ROLES;
    (globalThis as Global).__radulfOrchestrator = undefined;
    seedCard("c1", { status: "looping" });
    seedRun("r1", "c1");

    const orchestrator = getOrchestrator();
    orchestrator.startDraining();

    expect(run("r1").status).toBe("interrupted");
  });
});
