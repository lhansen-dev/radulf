import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

const mocks = vi.hoisted(() => ({ staleSeconds: 120 }));

vi.mock("./settings", async (importOriginal) => {
  // Built from the original's defaults rather than testSettings: that helper
  // loads @/server/settings, which is this very module, so importing it from
  // inside its own mock factory deadlocks. See orchestrator.roles.test.ts.
  const original = await importOriginal<typeof import("./settings")>();
  return {
    ...original,
    getSettings: () => ({
      ...original.SETTING_DEFAULTS,
      autoMode: false,
      sandboxEnabled: false,
      workerStaleSeconds: mocks.staleSeconds,
    }),
  };
});

const testDataDir = setupTestDataDir("radulf-orchestrator-reaper-");

const { db, cards, events, iterations, plans, repos, runs, workers, now } = await import("@/db");
const { Orchestrator, disposeAllOrchestrators } = await import("./orchestrator");
const { runScratchRoot } = await import("./sandbox/context");
const { planStatePath } = await import("./bookkeeping");

type Global = { __radulfOrchestrator?: unknown };

const secondsAgo = (s: number) => new Date(Date.now() - s * 1000).toISOString();

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

function seedWorker(id: string, heartbeatAt: string) {
  db.insert(workers)
    .values({ id, host: "test", pid: 1, roles: JSON.stringify(["worker"]), startedAt: heartbeatAt, heartbeatAt })
    .run();
}

const card = (id: string) => db.select().from(cards).where(eq(cards.id, id)).get()!;
const run = (id: string) => db.select().from(runs).where(eq(runs.id, id)).get()!;
const worker = (id: string) => db.select().from(workers).where(eq(workers.id, id)).get();

beforeEach(() => {
  mocks.staleSeconds = 120;
  db.delete(workers).run();
  db.delete(iterations).run();
  db.delete(runs).run();
  db.delete(plans).run();
  db.delete(events).run();
  db.delete(cards).run();
  db.delete(repos).run();
  db.insert(repos)
    .values({ id: "repo-1", name: "Repo", path: "/tmp/repo-1", defaultBranch: "main", createdAt: now() })
    .run();
  fs.rmSync(runScratchRoot(), { recursive: true, force: true });
});

afterEach(() => {
  disposeAllOrchestrators();
  (globalThis as Global).__radulfOrchestrator = undefined;
});

describe("stale reaper", () => {
  it("boot recovery reaps a dead worker's run but leaves a live peer's run alone", () => {
    seedWorker("dead", secondsAgo(600));
    seedWorker("alive", now());
    seedCard("c-dead", { status: "looping" });
    seedRun("r-dead", "c-dead", { workerId: "dead" });
    seedCard("c-live", { status: "looping", position: 2 });
    seedRun("r-live", "c-live", { workerId: "alive" });
    fs.mkdirSync(path.join(runScratchRoot(), "r-dead"), { recursive: true });
    fs.mkdirSync(path.join(runScratchRoot(), "r-live"), { recursive: true });

    const orchestrator = new Orchestrator();

    expect(run("r-dead").status).toBe("interrupted");
    expect(run("r-dead").exitReason).toContain("dead");
    expect(card("c-dead").status).toBe("needs_attention");
    expect(run("r-live").status).toBe("running");
    expect(card("c-live").status).toBe("looping");
    expect(fs.existsSync(path.join(runScratchRoot(), "r-live"))).toBe(true);
    expect(fs.existsSync(path.join(runScratchRoot(), "r-dead"))).toBe(false);
    expect(worker("dead")).toBeUndefined();
    expect(worker("alive")).toBeDefined();

    orchestrator.startDraining();
  });

  it("reaps an ownerless run as a server restart", () => {
    seedCard("c1", { status: "looping" });
    seedRun("r1", "c1", { workerId: null });

    new Orchestrator({ autoStart: false }).reapStaleRuns();

    expect(run("r1").status).toBe("interrupted");
    expect(run("r1").exitReason).toBe("server restarted mid-run");
    expect(card("c1").status).toBe("needs_attention");
  });

  it("never reaps its own run, however stale its heartbeat row looks", () => {
    const o = new Orchestrator({ autoStart: false });
    seedCard("c1", { status: "looping" });
    seedRun("r1", "c1", { workerId: o.workerId });
    mocks.staleSeconds = 15;
    db.update(workers).set({ heartbeatAt: secondsAgo(3600) }).where(eq(workers.id, o.workerId)).run();

    o.reapStaleRuns();

    expect(run("r1").status).toBe("running");
    expect(card("c1").status).toBe("looping");
  });

  it("reads the stale window at reap time, not at construction", () => {
    seedWorker("w1", secondsAgo(60));
    seedCard("c1", { status: "looping" });
    seedRun("r1", "c1", { workerId: "w1" });
    mocks.staleSeconds = 3600;
    const o = new Orchestrator({ autoStart: false });

    o.reapStaleRuns();
    expect(run("r1").status).toBe("running");

    mocks.staleSeconds = 15;
    o.reapStaleRuns();
    expect(run("r1").status).toBe("interrupted");
    expect(run("r1").exitReason).toBe("worker w1 stopped heartbeating");
  });

  it("the continuous pass leaves a run-less reviewing card alone", () => {
    seedCard("c1", { status: "reviewing", updatedAt: secondsAgo(600) });

    new Orchestrator({ autoStart: false }).reapStaleRuns();

    expect(card("c1").status).toBe("reviewing");
  });

  it("boot recovery parks a run-less reviewing card idle past the stale window", () => {
    seedCard("c1", { status: "reviewing", updatedAt: secondsAgo(600) });

    const o = new Orchestrator();

    expect(card("c1").status).toBe("needs_attention");

    o.startDraining();
  });

  it("puts a resumable loop back in ready", () => {
    seedWorker("dead", secondsAgo(600));
    seedCard("c1", { status: "looping" });
    db.insert(plans)
      .values({
        id: "p1",
        cardId: "c1",
        version: 1,
        planMd: "## Tasks\n- [x] a\n- [ ] b\n",
        promptMd: "",
        acceptanceCriteria: "",
        createdAt: now(),
      })
      .run();
    const planPath = planStatePath("c1");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, "## Tasks\n- [x] a\n- [ ] b\n");
    const worktreePath = path.join(testDataDir, "worktrees", "c1-run");
    fs.mkdirSync(worktreePath, { recursive: true });
    seedRun("r1", "c1", { workerId: "dead", worktreePath });

    new Orchestrator({ autoStart: false }).reapStaleRuns();

    expect(run("r1").status).toBe("interrupted");
    expect(card("c1").status).toBe("ready");
  });
});
