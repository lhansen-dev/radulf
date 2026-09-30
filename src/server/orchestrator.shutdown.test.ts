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

const testDataDir = setupTestDataDir("radulf-orchestrator-shutdown-");

const { db, cards, events, iterations, plans, repoLeases, repos, reviewDeliveries, runs, workers, now } =
  await import("@/db");
const { Orchestrator, disposeAllOrchestrators } = await import("./orchestrator");
const { runScratchRoot } = await import("./sandbox/context");
const { planStatePath } = await import("./bookkeeping");
const { HEARTBEAT_INTERVAL_MS } = await import("./workers");

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
  vi.useRealTimers();
});

describe("releaseOwnedWork", () => {
  it("interrupts its own resumable loop run and puts the card back in ready", () => {
    const o = new Orchestrator({ autoStart: false });
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
    seedRun("r1", "c1", { workerId: o.workerId, worktreePath });

    expect(o.releaseOwnedWork()).toEqual({ runs: 1, deliveries: 0 });

    expect(run("r1").status).toBe("interrupted");
    expect(run("r1").exitReason).toBe("worker shut down before this stage finished");
    expect(card("c1").status).toBe("ready");
    expect(worker(o.workerId)).toBeUndefined();
  });

  it("parks a planning run's card in needs_attention", () => {
    const o = new Orchestrator({ autoStart: false });
    seedCard("c1", { status: "planning" });
    seedRun("r1", "c1", { kind: "plan", workerId: o.workerId });

    expect(o.releaseOwnedWork()).toEqual({ runs: 1, deliveries: 0 });

    expect(run("r1").status).toBe("interrupted");
    expect(run("r1").exitReason).toBe("worker shut down before this stage finished");
    expect(card("c1").status).toBe("needs_attention");
  });

  it("never touches a peer's running run, lease or worker row", () => {
    const o = new Orchestrator({ autoStart: false });
    seedWorker("peer", now());
    seedCard("c2", { status: "looping" });
    seedRun("r2", "c2", { workerId: "peer" });
    db.insert(repoLeases).values({ repoPath: "/tmp/repo-1", workerId: "peer", acquiredAt: now() }).run();

    expect(o.releaseOwnedWork()).toEqual({ runs: 0, deliveries: 0 });

    expect(run("r2").status).toBe("running");
    expect(card("c2").status).toBe("looping");
    expect(lease("/tmp/repo-1")?.workerId).toBe("peer");
    expect(worker("peer")).toBeDefined();
  });

  it("deletes its own workers row and the heartbeat timer never re-inserts it", () => {
    vi.useFakeTimers();
    const o = new Orchestrator({ autoStart: false });
    expect(worker(o.workerId)).toBeDefined();

    o.releaseOwnedWork();

    expect(worker(o.workerId)).toBeUndefined();
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
    expect(worker(o.workerId)).toBeUndefined();
  });

  it("fails its own running review delivery, frees its lease and parks the card", () => {
    const o = new Orchestrator({ autoStart: false });
    seedCard("c1", { status: "reviewing" });
    seedRun("r1", "c1", { status: "completed", endedAt: now() });
    seedDelivery("d1", "c1", "r1", { status: "running", workerId: o.workerId, claimedAt: now() });
    db.insert(repoLeases).values({ repoPath: "/tmp/repo-1", workerId: o.workerId, acquiredAt: now() }).run();

    expect(o.releaseOwnedWork()).toEqual({ runs: 0, deliveries: 1 });

    expect(delivery("d1").status).toBe("finished");
    expect(delivery("d1").ok).toBe(0);
    expect(delivery("d1").error).toContain("press Retry merge");
    expect(delivery("d1").error).toContain("/tmp/repo-1");
    expect(lease("/tmp/repo-1")).toBeUndefined();
    expect(card("c1").status).toBe("needs_attention");
  });

  it("a fresh orchestrator pumps the released card at boot without waiting for the stale window", () => {
    const o = new Orchestrator({ autoStart: false });
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
    seedRun("r1", "c1", { workerId: o.workerId, worktreePath });

    expect(o.releaseOwnedWork()).toEqual({ runs: 1, deliveries: 0 });
    expect(card("c1").status).toBe("ready");

    // Spying on the claim lets the boot pump reach the card without starting a
    // real loop harness: the point is that a replacement worker sees the card
    // as claimable the moment it boots, not `workerStaleSeconds` later.
    const claim = vi.spyOn(Orchestrator.prototype, "claimLoopRun").mockReturnValue(null);
    const fresh = new Orchestrator();

    expect(claim).toHaveBeenCalledWith("c1");
    expect(card("c1").status).toBe("ready");
    expect(run("r1").status).toBe("interrupted");
    expect(worker(o.workerId)).toBeUndefined();

    claim.mockRestore();
    fresh.startDraining();
  });
});