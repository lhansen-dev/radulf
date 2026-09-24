import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

const mocks = vi.hoisted(() => ({
  proposeScopedPlan: vi.fn(),
  proposeSplit: vi.fn(),
}));

vi.mock("./scoping", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scoping")>()),
  proposeScopedPlan: mocks.proposeScopedPlan,
  proposeSplit: mocks.proposeSplit,
}));
vi.mock("./settings", async (importOriginal) => {
  // Built from the original's defaults rather than testSettings: that helper
  // loads @/server/settings, which is this very module, so importing it from
  // inside its own mock factory deadlocks. Importing it statically at the top
  // instead would load @/db before setupTestDataDir below and put this file
  // on the checkout's own database, where it raced planningService.test.ts.
  const original = await importOriginal<typeof import("./settings")>();
  return {
    ...original,
    // autoMode off: pump() must not reach for a real planner harness when the
    // breakdown queues its pieces.
    getSettings: () => ({ ...original.SETTING_DEFAULTS, autoMode: false, sandboxEnabled: false }),
  };
});

setupTestDataDir("radulf-orchestrator-scoping-");

const { db, cards, events, plans, repos, iterations, runs, workers, now } = await import("@/db");
const { Orchestrator, disposeAllOrchestrators } = await import("./orchestrator");

afterAll(() => {
  disposeAllOrchestrators();
});
const { readPlanState } = await import("./bookkeeping");

const orchestrator = new Orchestrator({ autoStart: false });

function seedCard(
  id: string,
  overrides: Partial<typeof cards.$inferInsert> = {},
) {
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

const PLAN_ARTIFACTS = {
  planMd: "# Card\n\n## Tasks\n\n- [ ] add the bucket\n- [ ] add the test\n",
  promptMd: "Next.js app. `make check` is the gate.",
  acceptanceCriteria: "- [ ] `make test` exits 0",
  messages: [],
};

beforeEach(() => {
  // Run-side tables first, in FK-safe order, since pump() now claims runs.
  db.delete(iterations).run();
  db.delete(runs).run();
  db.delete(workers).run();
  db.delete(events).run();
  db.delete(plans).run();
  db.delete(cards).run();
  db.delete(repos).run();
  db.insert(repos)
    .values({ id: "repo-1", name: "Repo", path: "/tmp/repo-1", defaultBranch: "main", createdAt: now() })
    .run();
  vi.clearAllMocks();
});

const allCards = () => db.select().from(cards).all().sort((a, b) => a.position - b.position);

describe("applyBreakdown", () => {
  const pieces = [
    { title: "  Add the limiter  ", description: "## Problem\nBrute force." },
    { title: "Surface the lockout", description: "## Problem\nDepends on card 1." },
    { title: "Document it", description: "## Problem\nNo docs." },
  ];

  it("makes the card an epic in Backlog and queues its pieces at the end, in order, with its settings", () => {
    // A card already in the queue, so the pieces have a position to appear after.
    seedCard("other", { status: "todo", position: 7 });
    seedCard("epic", {
      status: "todo",
      position: 8,
      startedAt: now(),
      baseBranch: "release/2",
      maxIterations: 9,
      autoApprove: 1,
      grillMe: 1,
      scopingAuthorsPlan: 1,
      loopModel: "a-loop-model",
    });

    const result = orchestrator.applyBreakdown("epic", pieces, "parallel");

    expect(result.map((row) => row.title)).toEqual(["Add the limiter", "Surface the lockout", "Document it"]);
    const queued = allCards().filter((row) => row.status === "todo");
    expect(queued.map((row) => row.id)).toEqual(["other", ...result.map((row) => row.id)]);
    // The epic's own slot is vacated first, so the pieces follow the card that stays.
    expect(queued.slice(1).map((row) => row.position)).toEqual([8, 9, 10]);
    // The epic itself leaves the queue, keeps its description, and never runs.
    expect(allCards().find((row) => row.id === "epic")).toMatchObject({
      status: "backlog", runMode: "parallel", startedAt: null, description: "Rough ask",
    });
    // The pieces point at it and inherit every per-card setting.
    for (const child of result) {
      expect(child).toMatchObject({
        parentCardId: "epic",
        repoId: "repo-1",
        baseBranch: "release/2",
        maxIterations: 9,
        autoApprove: 1,
        grillMe: 1,
        scopingAuthorsPlan: 1,
        loopModel: "a-loop-model",
      });
    }
    const event = db.select().from(events).all().find((e) => e.type === "card.breakdown");
    expect(JSON.parse(event!.payload)).toEqual({ cardIds: result.map((row) => row.id), runMode: "parallel", from: "todo" });
  });

  it("lets a piece target another repository, where the epic's base branch does not apply", () => {
    db.insert(repos)
      .values({ id: "repo-2", name: "Other", path: "/tmp/repo-2", defaultBranch: "main", createdAt: now() })
      .run();
    seedCard("epic", { baseBranch: "release/2" });

    const [here, there] = orchestrator.applyBreakdown("epic", [pieces[0], { ...pieces[1], repoId: "repo-2" }], "ordered");

    expect(here).toMatchObject({ repoId: "repo-1", baseBranch: "release/2" });
    expect(there).toMatchObject({ repoId: "repo-2", baseBranch: null });
    expect(() => orchestrator.applyBreakdown("epic", [{ ...pieces[2], repoId: "nope" }], "ordered")).toThrow(/repo/);
    expect(allCards().filter((row) => row.parentCardId === "epic")).toHaveLength(2);
  });

  it("persists each piece's dependencies as sibling ids under graph", () => {
    seedCard("epic");

    const result = orchestrator.applyBreakdown(
      "epic",
      [pieces[0], { ...pieces[1], dependsOn: [0] }, { ...pieces[2], dependsOn: [0, 1] }],
      "graph",
    );

    expect(result[0].dependsOn).toBeNull();
    expect(result[1].dependsOn).toEqual([result[0].id]);
    expect(result[2].dependsOn).toEqual([result[0].id, result[1].id]);
    expect(db.select().from(cards).where(eq(cards.id, "epic")).get()).toMatchObject({ runMode: "graph" });
  });

  it("rejects a dependency cycle naming the pieces", () => {
    seedCard("epic");

    expect(() =>
      orchestrator.applyBreakdown(
        "epic",
        [{ ...pieces[0], dependsOn: [1] }, { ...pieces[1], dependsOn: [0] }],
        "graph",
      ),
    ).toThrow(
      /dependency cycle: "Add the limiter" \u2192 "Surface the lockout" \u2192 "Add the limiter"|dependency cycle: "Surface the lockout" \u2192 "Add the limiter" \u2192 "Surface the lockout"/,
    );
    expect(() => orchestrator.applyBreakdown("epic", [{ ...pieces[0], dependsOn: [7] }], "graph")).toThrow(
      /invalid dependency/,
    );
    expect(allCards().filter((row) => row.parentCardId === "epic")).toHaveLength(0);
  });

  it("appends more pieces to an epic that already has some", () => {
    seedCard("epic");
    const first = orchestrator.applyBreakdown("epic", pieces.slice(0, 2), "ordered");
    const more = orchestrator.applyBreakdown("epic", pieces.slice(2), "ordered");
    expect(allCards().filter((row) => row.parentCardId === "epic").map((row) => row.id))
      .toEqual([...first, ...more].map((row) => row.id));
  });

  it("refuses a planned card, rather than leaving the pieces beside a stale plan", () => {
    seedCard("planned");
    db.insert(plans)
      .values({
        id: "plan-1",
        cardId: "planned",
        version: 1,
        planMd: "## Tasks\n- [ ] old scope\n",
        promptMd: "p",
        acceptanceCriteria: "c",
        createdAt: now(),
      })
      .run();

    expect(() => orchestrator.applyBreakdown("planned", pieces, "ordered")).toThrow(/already planned/);
    expect(allCards()).toHaveLength(1);
  });

  it("refuses a piece of an epic, an empty breakdown, a piece with no title, and a card past scoping", () => {
    seedCard("epic");
    seedCard("piece", { parentCardId: "epic" });
    seedCard("thin");
    seedCard("running", { status: "looping" });

    expect(() => orchestrator.applyBreakdown("piece", pieces, "ordered")).toThrow(/part of an epic/);
    expect(() => orchestrator.applyBreakdown("thin", [], "ordered")).toThrow(/at least one/);
    expect(() => orchestrator.applyBreakdown("thin", [pieces[0], { title: " ", description: "x" }], "ordered"))
      .toThrow(/needs a title/);
    expect(() => orchestrator.applyBreakdown("running", pieces, "ordered")).toThrow(/status looping/);
  });
});

describe("an epic", () => {
  it("is never queued or started itself", () => {
    seedCard("epic");
    seedCard("piece", { parentCardId: "epic", status: "todo" });

    expect(() => orchestrator.queueCard("epic")).toThrow(/does not run itself/);
    db.update(cards).set({ status: "todo" }).where(eq(cards.id, "epic")).run();
    expect(() => orchestrator.startCard("epic")).toThrow(/does not run itself/);
  });

  it("Start all queues the pieces still in Backlog and marks every queued piece as started", () => {
    seedCard("epic", { runMode: "ordered" });
    seedCard("a", { parentCardId: "epic", status: "todo", position: 1 });
    seedCard("b", { parentCardId: "epic", status: "backlog", position: 2 });
    seedCard("c", { parentCardId: "epic", status: "done", position: 3 });
    seedCard("other", { status: "todo", position: 5 });
    // Marked as started, the pieces are eligible even with Auto Mode off, so
    // the pump would reach for a planner here; the queue is what is under test.
    const pump = vi.spyOn(orchestrator, "pump").mockImplementation(() => {});
    try {
      expect(orchestrator.startEpic("epic")).toEqual({ queued: 1, started: 2 });
    } finally {
      pump.mockRestore();
    }

    const rows = Object.fromEntries(allCards().map((row) => [row.id, row]));
    expect(rows.a.status).toBe("todo");
    expect(rows.a.startedAt).not.toBeNull();
    expect(rows.b).toMatchObject({ status: "todo", position: 6 });
    expect(rows.b.startedAt).not.toBeNull();
    expect(rows.c.status).toBe("done");
    expect(db.select().from(events).all().filter((e) => e.type === "card.moved").map((e) => e.cardId)).toEqual(["b"]);
    expect(() => orchestrator.startEpic("other")).toThrow(/no tasks/);
  });

  it("Pause all pauses the looping pieces and no others", () => {
    seedCard("epic");
    seedCard("a", { parentCardId: "epic", status: "looping" });
    seedCard("b", { parentCardId: "epic", status: "todo" });

    expect(orchestrator.pauseEpic("epic")).toEqual({ paused: 1 });
    // Spec 25 decision 4: the pause is an immediate card transition.
    const rows = Object.fromEntries(allCards().map((row) => [row.id, row]));
    expect(rows.a.status).toBe("paused");
    expect(rows.b.status).toBe("todo");
  });

  it("finishes when its last unfinished piece does, and not before", () => {
    seedCard("epic");
    seedCard("a", { parentCardId: "epic", status: "done", position: 1 });
    seedCard("b", { parentCardId: "epic", status: "review", position: 2 });
    const move = (orchestrator as unknown as { moveCard: (id: string, from: string, to: string) => boolean }).moveCard.bind(orchestrator);

    move("b", "review", "reviewing");
    expect(allCards().find((row) => row.id === "epic")!.status).toBe("backlog");

    move("b", "reviewing", "done");
    expect(allCards().find((row) => row.id === "epic")!.status).toBe("done");
    expect(db.select().from(events).all().map((e) => e.type)).toContain("epic.completed");
  });
});

describe("adoptScopingPlan", () => {
  it("stamps the plan as scoping-authored and readies the card without a planning run", async () => {
    seedCard("authored", { status: "todo", scopingAuthorsPlan: 1 });
    mocks.proposeScopedPlan.mockResolvedValue(PLAN_ARTIFACTS);

    const result = await orchestrator.adoptScopingPlan("authored");

    expect(result).toEqual({ version: 1, status: "ready" });
    const [plan] = db.select().from(plans).all();
    expect(plan).toMatchObject({ cardId: "authored", version: 1, origin: "scoping" });
    // The private checklist is what the loop reads, and no run was needed.
    expect(readPlanState("authored")).toBe(PLAN_ARTIFACTS.planMd);
    // The card lands in Ready and the pump immediately claims it: since spec 25
    // decision 2 the claim is synchronous (claimLoopRun inside pump()), so by the
    // time adoptScopingPlan resolves the card is already looping with a loop run.
    expect(allCards()[0].status).toBe("looping");
    const allRuns = db.select().from(runs).all();
    expect(allRuns).toHaveLength(1);
    expect(allRuns[0]).toMatchObject({
      cardId: "authored",
      kind: "loop",
      status: "running",
      workerId: orchestrator.workerId,
    });
  });

  it("sends an opted-in card to plan review when it asked for one", async () => {
    seedCard("reviewed", { status: "todo", scopingAuthorsPlan: 1, reviewPlanBeforeImplementation: 1 });
    mocks.proposeScopedPlan.mockResolvedValue(PLAN_ARTIFACTS);

    expect(await orchestrator.adoptScopingPlan("reviewed")).toEqual({ version: 1, status: "plan_review" });
    expect(allCards()[0].status).toBe("plan_review");
  });

  it("refuses a plan whose checklist has nothing to run, and writes no row", async () => {
    seedCard("empty", { status: "todo", scopingAuthorsPlan: 1 });
    mocks.proposeScopedPlan.mockResolvedValue({ ...PLAN_ARTIFACTS, planMd: "# Card\n\nno tasks here" });

    await expect(orchestrator.adoptScopingPlan("empty")).rejects.toThrow(/checklist/);
    expect(db.select().from(plans).all()).toHaveLength(0);
    expect(allCards()[0].status).toBe("todo");
  });

  it("refuses a card past scoping before it spends a model turn", async () => {
    seedCard("late", { status: "review", scopingAuthorsPlan: 1 });

    await expect(orchestrator.adoptScopingPlan("late")).rejects.toThrow(/status review/);
    expect(mocks.proposeScopedPlan).not.toHaveBeenCalled();
  });
});
