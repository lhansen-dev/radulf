import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";
import { testSettings } from "@/testUtils/testSettings";

const mocks = vi.hoisted(() => ({
  proposeScopedPlan: vi.fn(),
  proposeSplit: vi.fn(),
}));

vi.mock("./scoping", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scoping")>()),
  proposeScopedPlan: mocks.proposeScopedPlan,
  proposeSplit: mocks.proposeSplit,
}));
vi.mock("./settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settings")>()),
  // autoMode off: pump() must not reach for a real planner harness when the
  // split queues its cards.
  getSettings: () => testSettings({ autoMode: false, sandboxEnabled: false }),
}));

setupTestDataDir("radulf-orchestrator-scoping-");

const { db, cards, events, plans, repos, now } = await import("@/db");
const { Orchestrator } = await import("./orchestrator");
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

describe("applyScopingSplit", () => {
  const items = [
    { title: "  Add the limiter  ", description: "## Problem\nBrute force." },
    { title: "Surface the lockout", description: "## Problem\nDepends on card 1." },
    { title: "Document it", description: "## Problem\nNo docs." },
  ];

  it("rewrites the card as the first piece and queues the rest in order", () => {
    // A card already in the queue, so the split has a position to appear after.
    seedCard("other", { status: "todo", position: 7 });
    seedCard("split-me", {
      baseBranch: "release/2",
      maxIterations: 9,
      autoApprove: 1,
      grillMe: 1,
      scopingAuthorsPlan: 1,
      loopModel: "a-loop-model",
    });

    const result = orchestrator.applyScopingSplit("split-me", items);

    expect(result.map((row) => row.title)).toEqual([
      "Add the limiter",
      "Surface the lockout",
      "Document it",
    ]);
    // Appended to the end of the queue, in order, after the card that was
    // already there.
    const queued = allCards().filter((row) => row.status === "todo");
    expect(queued.map((row) => row.id)).toEqual(["other", "split-me", ...result.slice(1).map((r) => r.id)]);
    expect(queued.slice(1).map((row) => row.position)).toEqual([8, 9, 10]);

    // The original keeps its id, and so its thread and its history.
    expect(result[0].id).toBe("split-me");
    expect(result[0].description).toBe("## Problem\nBrute force.");
    // The siblings inherit every per-card setting.
    for (const sibling of result.slice(1)) {
      expect(sibling).toMatchObject({
        repoId: "repo-1",
        baseBranch: "release/2",
        maxIterations: 9,
        autoApprove: 1,
        grillMe: 1,
        scopingAuthorsPlan: 1,
        loopModel: "a-loop-model",
      });
    }
    expect(db.select().from(events).all().map((e) => e.type)).toContain("card.split");
  });

  it("refuses a card that is already planned, rather than leaving the pieces on a stale plan", () => {
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

    expect(() => orchestrator.applyScopingSplit("planned", items)).toThrow(/already planned/);
    expect(allCards()).toHaveLength(1);
  });

  it("refuses fewer than two cards, a card with no title, and a card past scoping", () => {
    seedCard("thin");
    seedCard("running", { status: "looping" });

    expect(() => orchestrator.applyScopingSplit("thin", items.slice(0, 1))).toThrow(/two or more/);
    expect(() => orchestrator.applyScopingSplit("thin", [items[0], { title: " ", description: "x" }]))
      .toThrow(/needs a title/);
    expect(() => orchestrator.applyScopingSplit("running", items)).toThrow(/status looping/);
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
    expect(allCards()[0].status).toBe("ready");
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
