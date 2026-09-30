import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

// The orchestrator singleton is only reached through defaultDeps, which every
// test here replaces, but importing schedules.ts pulls it into the graph.
vi.mock("./orchestrator", () => ({ getOrchestrator: () => ({ startCard: () => {} }) }));

setupTestDataDir("radulf-schedules-");

const { db, cards, events, repos, schedules, now } = await import("@/db");
const {
  claimScheduleFire,
  createSchedule,
  deleteSchedule,
  fireDueSchedules,
  listSchedules,
  updateSchedule,
} = await import("./schedules");

const deps = {
  startCard: vi.fn(),
  createImprovementRun: vi.fn().mockResolvedValue({}),
};

function queuedCard(id: string, overrides: Partial<typeof cards.$inferInsert> = {}) {
  db.insert(cards)
    .values({
      id,
      repoId: "repo-1",
      title: `Card ${id}`,
      status: "todo",
      position: Number(id.replace(/\D/g, "")) || 1,
      startedAt: null,
      createdAt: now(),
      updatedAt: now(),
      ...overrides,
    })
    .run();
}

const nightly = { kind: "queue-drain" as const, repoId: null, cron: "0 3 * * *" };

beforeEach(() => {
  db.delete(events).run();
  db.delete(schedules).run();
  db.delete(cards).run();
  db.delete(repos).run();
  for (const id of ["repo-1", "repo-2"]) {
    db.insert(repos)
      .values({ id, name: id, path: `/tmp/${id}`, defaultBranch: "main", createdAt: now() })
      .run();
  }
  deps.startCard.mockReset();
  deps.createImprovementRun.mockReset().mockResolvedValue({});
});

const eventTypes = () => db.select().from(events).all().map((row) => row.type);
const stored = (id: string) => db.select().from(schedules).all().find((row) => row.id === id)!;

describe("createSchedule", () => {
  it("stores a queue drain and reports when it will next fire", () => {
    const row = createSchedule(nightly);

    expect(row).toMatchObject({ kind: "queue-drain", repoId: null, cron: "0 3 * * *", enabled: 1 });
    // A drain takes no arguments, so a config handed in is dropped.
    expect(row.config).toBe("{}");
    // The upcoming times are how the expression is read back: three concrete
    // timestamps instead of a prose rendering.
    expect(listSchedules(new Date("2026-09-22T12:00:00"))[0].upcoming).toEqual([
      new Date("2026-09-23T03:00:00").toISOString(),
      new Date("2026-09-24T03:00:00").toISOString(),
      new Date("2026-09-25T03:00:00").toISOString(),
    ]);
    expect(eventTypes()).toContain("schedule.created");
  });

  it("refuses an expression that does not parse, naming what is wrong", () => {
    expect(() => createSchedule({ ...nightly, cron: "0 3 * *" })).toThrow(/five fields/);
    expect(() => createSchedule({ ...nightly, cron: "99 3 * * *" })).toThrow(/minute range/);
  });

  it("refuses a kind it does not have, and a repo it cannot find", () => {
    expect(() => createSchedule({ ...nightly, kind: "deploy" as never })).toThrow(/kind must be one of/);
    expect(() => createSchedule({ ...nightly, repoId: "nope" })).toThrow(/does not exist/);
  });

  it("holds an improvement run's arguments, and insists on the ones it needs", () => {
    const base = { kind: "improvement-run" as const, cron: "0 2 * * 1-5", repoId: "repo-1" };

    expect(() => createSchedule({ ...base, repoId: null })).toThrow(/needs a repoId/);
    expect(() => createSchedule({ ...base, config: { budgetMinutes: 60 } })).toThrow(/needs a baseBranch/);
    expect(() => createSchedule({ ...base, config: { baseBranch: "beta" } })).toThrow(/budgetMinutes/);
    expect(() => createSchedule({ ...base, config: { baseBranch: "beta", budgetMinutes: 0 } }))
      .toThrow(/budgetMinutes/);

    const row = createSchedule({
      ...base,
      config: { baseBranch: " beta ", budgetMinutes: 90, focusPrompt: "tests" },
    });

    expect(JSON.parse(row.config)).toEqual({ baseBranch: "beta", budgetMinutes: 90, focusPrompt: "tests" });
  });
});

describe("updateSchedule", () => {
  it("suspends a cadence without losing its configuration", () => {
    const row = createSchedule({
      kind: "improvement-run",
      cron: "0 2 * * *",
      repoId: "repo-1",
      config: { baseBranch: "beta", budgetMinutes: 90 },
    });

    const off = updateSchedule(row.id, { enabled: false });

    expect(off.enabled).toBe(0);
    expect(JSON.parse(off.config)).toMatchObject({ baseBranch: "beta", budgetMinutes: 90 });
    // A disabled schedule has no fire times to show.
    expect(listSchedules()[0].upcoming).toEqual([]);
  });

  it("re-validates the whole row, so an edit cannot leave an illegal combination", () => {
    const row = createSchedule(nightly);

    expect(() => updateSchedule(row.id, { kind: "improvement-run" })).toThrow(/needs a repoId/);
    expect(() => updateSchedule(row.id, { cron: "nonsense" })).toThrow(/five fields/);
    expect(stored(row.id).kind).toBe("queue-drain");
  });

  it("404s on a schedule that is not there, for both verbs", () => {
    expect(() => updateSchedule("gone", { enabled: false })).toThrow(/not found/);
    expect(() => deleteSchedule("gone")).toThrow(/not found/);
  });
});

describe("fireDueSchedules", () => {
  const at3am = new Date("2026-09-22T03:00:30");

  it("starts every queued card and records what it did", async () => {
    const row = createSchedule(nightly);
    queuedCard("card-1");
    queuedCard("card-2");
    // Already started by hand, so it is not the drain's to start.
    queuedCard("card-3", { startedAt: "2026-09-22T01:00:00.000Z" });

    const [result] = await fireDueSchedules(at3am, deps);

    expect(result).toMatchObject({ outcome: "started", detail: "started 2 of 2 queued cards" });
    expect(deps.startCard.mock.calls.map(([id]) => id)).toEqual(["card-1", "card-2"]);
    expect(stored(row.id).lastFiredAt).toBe(at3am.toISOString());
    expect(stored(row.id).lastError).toBeNull();
    expect(eventTypes()).toContain("schedule.fired");
  });

  it("does not fire at a minute the expression does not name", async () => {
    createSchedule(nightly);
    queuedCard("card-1");

    expect(await fireDueSchedules(new Date("2026-09-22T03:01:00"), deps)).toEqual([]);
    expect(deps.startCard).not.toHaveBeenCalled();
  });

  it("fires once per minute however often the tick runs", async () => {
    createSchedule(nightly);
    queuedCard("card-1");

    await fireDueSchedules(at3am, deps);
    await fireDueSchedules(new Date("2026-09-22T03:00:59"), deps);

    expect(deps.startCard).toHaveBeenCalledTimes(1);
  });

  it("never replays a tick the server was down for", async () => {
    createSchedule(nightly);
    queuedCard("card-1");

    // Booted at 09:00, hours past the 03:00 the schedule names.
    expect(await fireDueSchedules(new Date("2026-09-22T09:00:00"), deps)).toEqual([]);
    expect(deps.startCard).not.toHaveBeenCalled();
  });

  it("leaves a disabled schedule alone", async () => {
    const row = createSchedule(nightly);
    updateSchedule(row.id, { enabled: false });
    queuedCard("card-1");

    expect(await fireDueSchedules(at3am, deps)).toEqual([]);
  });

  it("drains only its own repo when it names one", async () => {
    createSchedule({ ...nightly, repoId: "repo-2" });
    queuedCard("card-1", { repoId: "repo-1" });
    queuedCard("card-2", { repoId: "repo-2" });

    await fireDueSchedules(at3am, deps);

    expect(deps.startCard.mock.calls.map(([id]) => id)).toEqual(["card-2"]);
  });

  it("skips, rather than fails, a drain with an empty queue", async () => {
    const row = createSchedule(nightly);

    const [result] = await fireDueSchedules(at3am, deps);

    expect(result).toMatchObject({ outcome: "skipped", detail: "nothing waiting in the queue" });
    expect(stored(row.id).lastError).toBeNull();
  });

  it("lets the rest of the queue drain when one card refuses to start", async () => {
    createSchedule(nightly);
    queuedCard("card-1");
    queuedCard("card-2");
    deps.startCard.mockImplementationOnce(() => {
      throw new Error("cannot start card in status todo");
    });

    const [result] = await fireDueSchedules(at3am, deps);

    expect(result.outcome).toBe("started");
    expect(result.detail).toContain("started 1 of 2");
    expect(deps.startCard).toHaveBeenCalledTimes(2);
  });

  it("starts an improvement run with the schedule's own arguments", async () => {
    const row = createSchedule({
      kind: "improvement-run",
      cron: "0 3 * * *",
      repoId: "repo-1",
      config: { baseBranch: "beta", budgetMinutes: 90, focusPrompt: "tests" },
    });

    const [result] = await fireDueSchedules(at3am, deps);

    expect(result).toMatchObject({ outcome: "started", detail: "improvement run on beta" });
    expect(deps.createImprovementRun).toHaveBeenCalledWith({
      repoId: "repo-1",
      baseBranch: "beta",
      budgetMinutes: 90,
      focusPrompt: "tests",
    });
    expect(stored(row.id).lastResult).toBe("improvement run on beta");
  });

  it("skips a repo that already has a run, because that rule is not a schedule's to bend", async () => {
    const row = createSchedule({
      kind: "improvement-run",
      cron: "0 3 * * *",
      repoId: "repo-1",
      config: { baseBranch: "beta", budgetMinutes: 90 },
    });
    deps.createImprovementRun.mockRejectedValue(
      new Error("an improvement run is already active for this repo"),
    );

    const [result] = await fireDueSchedules(at3am, deps);

    expect(result.outcome).toBe("skipped");
    expect(stored(row.id).lastError).toBeNull();
  });

  it("fires once across two workers in the same minute", () => {
    const { id } = createSchedule(nightly);
    queuedCard("card-1");
    // Both workers read the same snapshot before either stamps it.
    const row = stored(id);

    expect(claimScheduleFire(row, at3am)).toBe(true);
    expect(claimScheduleFire(row, at3am)).toBe(false);
    expect(stored(id).lastFiredAt).toBe(at3am.toISOString());
  });

  it("a peer's stamp between the read and the fire wins", async () => {
    const { id } = createSchedule(nightly);
    queuedCard("card-1");
    // The peer got there first: it stamped the minute this tick is about to claim.
    db.update(schedules).set({ lastFiredAt: at3am.toISOString() }).where(eq(schedules.id, id)).run();

    expect(await fireDueSchedules(at3am, deps)).toEqual([]);
    expect(deps.startCard).not.toHaveBeenCalled();
  });

  it("two overlapping ticks start the work exactly once between them", async () => {
    createSchedule(nightly);
    queuedCard("card-1");
    const depsA = { startCard: vi.fn(), createImprovementRun: vi.fn().mockResolvedValue({}) };
    const depsB = { startCard: vi.fn(), createImprovementRun: vi.fn().mockResolvedValue({}) };

    await Promise.all([fireDueSchedules(at3am, depsA), fireDueSchedules(at3am, depsB)]);

    expect(depsA.startCard.mock.calls.length + depsB.startCard.mock.calls.length).toBe(1);
    expect(eventTypes().filter((type) => type === "schedule.fired")).toHaveLength(1);
  });

  it("records a real failure and stays enabled, so the next tick can pick the work back up", async () => {
    const row = createSchedule({
      kind: "improvement-run",
      cron: "0 3 * * *",
      repoId: "repo-1",
      config: { baseBranch: "beta", budgetMinutes: 90 },
    });
    deps.createImprovementRun.mockRejectedValue(new Error("baseBranch does not exist"));

    const [result] = await fireDueSchedules(at3am, deps);

    expect(result.outcome).toBe("failed");
    expect(stored(row.id)).toMatchObject({ enabled: 1, lastError: "baseBranch does not exist" });
  });
});
