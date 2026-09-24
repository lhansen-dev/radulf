import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { setupTestDataDir } from "@/testUtils/testDataDir";

setupTestDataDir("radulf-workers-");

const { db, workers } = await import("@/db");
const {
  HEARTBEAT_INTERVAL_MS,
  deleteWorker,
  heartbeatWorker,
  listWorkers,
  liveWorkerIds,
  registerWorker,
  staleBefore,
  staleWorkerIds,
} = await import("./workers");

function getWorker(id: string) {
  return db.select().from(workers).where(eq(workers.id, id)).get();
}

describe("workers registry", () => {
  beforeEach(() => {
    db.delete(workers).run();
  });

  it("exposes a sane heartbeat interval", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBeGreaterThanOrEqual(500);
  });

  it("registerWorker inserts a row for this process and returns its id", () => {
    const id = registerWorker(["orchestrator", "web"]);
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    const row = getWorker(id);
    expect(row).toBeDefined();
    expect(row!.pid).toBe(process.pid);
    expect(row!.roles).toBe(JSON.stringify(["orchestrator", "web"]));
    expect(row!.host.length).toBeGreaterThan(0);
    expect(row!.startedAt).toBe(row!.heartbeatAt);
    expect(listWorkers().map((w) => w.id)).toEqual([id]);
  });

  it("heartbeatWorker advances heartbeatAt", async () => {
    const id = registerWorker(["orchestrator"]);
    const before = getWorker(id)!.heartbeatAt;
    await new Promise((r) => setTimeout(r, 5));
    heartbeatWorker(id);
    const after = getWorker(id)!.heartbeatAt;
    expect(after > before).toBe(true);
  });

  it("staleBefore returns an ISO timestamp staleSeconds in the past", () => {
    const ts = staleBefore(120);
    const diff = Date.now() - new Date(ts).getTime();
    expect(diff).toBeGreaterThanOrEqual(120_000);
    expect(diff).toBeLessThan(121_000);
  });

  it("classifies stale and live workers by heartbeat age", () => {
    const stale = registerWorker(["orchestrator"]);
    const fresh = registerWorker(["orchestrator"]);
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    db.update(workers).set({ heartbeatAt: tenMinutesAgo }).where(eq(workers.id, stale)).run();

    const staleIds = staleWorkerIds(120);
    const liveIds = liveWorkerIds(120);

    expect(staleIds).toContain(stale);
    expect(staleIds).not.toContain(fresh);
    expect(liveIds.has(fresh)).toBe(true);
    expect(liveIds.has(stale)).toBe(false);
  });

  it("deleteWorker removes the row", () => {
    const id = registerWorker(["orchestrator"]);
    const other = registerWorker(["web"]);
    deleteWorker(id);
    expect(getWorker(id)).toBeUndefined();
    expect(getWorker(other)).toBeDefined();
  });
});
