import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
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

const {
  db,
  cards,
  events,
  iterations,
  plans,
  repoLeases,
  repos,
  reviewDeliveries,
  reviews,
  runs,
  workers,
  now,
} = await import("@/db");
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

function seedDelivery(
  id: string,
  cardId: string,
  runId: string,
  overrides: Partial<typeof reviewDeliveries.$inferInsert> = {},
) {
  db.insert(reviewDeliveries)
    .values({
      id,
      runId,
      cardId,
      repoId: "repo-1",
      fromStatus: "review",
      approvedBy: "human",
      status: "pending",
      createdAt: now(),
      ...overrides,
    })
    .run();
}

const card = (id: string) => db.select().from(cards).where(eq(cards.id, id)).get()!;
const delivery = (id: string) => db.select().from(reviewDeliveries).where(eq(reviewDeliveries.id, id)).get()!;
const lease = (repoPath: string) => db.select().from(repoLeases).where(eq(repoLeases.repoPath, repoPath)).get();
const run = (id: string) => db.select().from(runs).where(eq(runs.id, id)).get()!;
const worker = (id: string) => db.select().from(workers).where(eq(workers.id, id)).get();

beforeEach(() => {
  mocks.staleSeconds = 120;
  db.delete(reviewDeliveries).run();
  db.delete(reviews).run();
  db.delete(repoLeases).run();
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

describe("delivery reaper (spec 25 decision 6)", () => {
  it("fails a running delivery owned by a dead worker, frees its lease and parks the card", () => {
    seedWorker("dead", secondsAgo(600));
    seedCard("c1", { status: "reviewing" });
    seedRun("r1", "c1", { status: "completed", endedAt: now() });
    seedDelivery("d1", "c1", "r1", { status: "running", workerId: "dead", claimedAt: secondsAgo(600) });
    db.insert(repoLeases).values({ repoPath: "/tmp/repo-1", workerId: "dead", acquiredAt: secondsAgo(600) }).run();

    new Orchestrator({ autoStart: false }).reapStaleRuns();

    expect(delivery("d1").status).toBe("finished");
    expect(delivery("d1").ok).toBe(0);
    expect(delivery("d1").error).toContain("dead");
    expect(delivery("d1").error).toContain("press Retry merge");
    expect(delivery("d1").error).toContain("/tmp/repo-1");
    expect(delivery("d1").error).toContain("record it if it already landed");
    expect(lease("/tmp/repo-1")).toBeUndefined();
    expect(card("c1").status).toBe("needs_attention");

    const moves = db
      .select()
      .from(events)
      .where(and(eq(events.cardId, "c1"), eq(events.type, "card.moved")))
      .all()
      .map((e) => JSON.parse(e.payload) as { to: string; reason?: string });
    const parked = moves.find((m) => m.to === "needs_attention");
    expect(parked?.reason).toContain("press Retry merge");
    expect(parked?.reason).toContain("/tmp/repo-1");

    const decided = db
      .select()
      .from(events)
      .where(and(eq(events.cardId, "c1"), eq(events.type, "review.decided")))
      .all()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    expect(decided.length).toBeGreaterThan(0);
    const newest = JSON.parse(decided[0].payload) as { deliveryFailed?: string };
    expect(newest.deliveryFailed).toContain("press Retry merge");
  });

  it("finishes a dead worker's delivery as landed when its card is already done", () => {
    seedWorker("dead", secondsAgo(600));
    seedCard("c1", { status: "done" });
    seedRun("r1", "c1", { status: "completed", endedAt: now() });
    db.insert(reviews)
      .values({ id: "rev1", runId: "r1", decision: "approved", mergeCommit: "abc123", createdAt: now() })
      .run();
    seedDelivery("d1", "c1", "r1", { status: "running", workerId: "dead", claimedAt: secondsAgo(600) });
    db.insert(repoLeases).values({ repoPath: "/tmp/repo-1", workerId: "dead", acquiredAt: secondsAgo(600) }).run();

    new Orchestrator({ autoStart: false }).reapStaleRuns();

    expect(delivery("d1").status).toBe("finished");
    expect(delivery("d1").ok).toBe(1);
    expect(delivery("d1").error).toBeNull();
    expect(card("c1").status).toBe("done");
    expect(lease("/tmp/repo-1")).toBeUndefined();

    const decided = db
      .select()
      .from(events)
      .where(and(eq(events.cardId, "c1"), eq(events.type, "review.decided")))
      .all()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
    expect(decided.length).toBeGreaterThan(0);
    const newest = JSON.parse(decided[0].payload) as {
      decision?: string;
      mergeCommit?: string;
      recoveredAfterWorkerLoss?: boolean;
      deliveryFailed?: string;
    };
    expect(newest.decision).toBe("approved");
    expect(newest.mergeCommit).toBe("abc123");
    expect(newest.recoveredAfterWorkerLoss).toBe(true);
    expect(newest.deliveryFailed).toBeUndefined();

    const moved = db
      .select()
      .from(events)
      .where(and(eq(events.cardId, "c1"), eq(events.type, "card.moved")))
      .all()
      .map((e) => JSON.parse(e.payload) as { to: string });
    expect(moved.find((m) => m.to === "needs_attention")).toBeUndefined();
  });

  it("leaves a running delivery owned by a live worker alone", () => {
    seedWorker("alive", now());
    seedCard("c1", { status: "reviewing" });
    seedRun("r1", "c1", { status: "completed", endedAt: now() });
    seedDelivery("d1", "c1", "r1", { status: "running", workerId: "alive", claimedAt: now() });
    db.insert(repoLeases).values({ repoPath: "/tmp/repo-1", workerId: "alive", acquiredAt: now() }).run();

    new Orchestrator({ autoStart: false }).reapStaleRuns();

    expect(delivery("d1").status).toBe("running");
    expect(lease("/tmp/repo-1")?.workerId).toBe("alive");
    expect(card("c1").status).toBe("reviewing");
  });

  it("the orphan sweep skips a reviewing card whose delivery is still pending", () => {
    seedCard("c1", { status: "reviewing", updatedAt: secondsAgo(600) });
    seedRun("r1", "c1", { status: "completed", endedAt: now() });
    seedDelivery("d1", "c1", "r1", { status: "pending" });

    new Orchestrator({ autoStart: false }).reapStaleRuns({ orphans: true });

    expect(card("c1").status).toBe("reviewing");
    expect(delivery("d1").status).toBe("pending");
  });
});
