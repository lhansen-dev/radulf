import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { setupTestDataDir } from "@/testUtils/testDataDir";

setupTestDataDir("radulf-improvement-run-leases-");

const { db, now, improvementRuns, repos, workers } = await import("@/db");
const {
  claimImprovementRun,
  heartbeatImprovementRun,
  releaseImprovementRun,
  improvementRunLeaseHolder,
} = await import("./improvementRunLeases");

const STALE_SECONDS = 120;
const RUN_ID = "run-1";
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function seedWorker(id: string, heartbeatAt: string) {
  db.insert(workers)
    .values({ id, host: "h", pid: 1, roles: "[]", startedAt: heartbeatAt, heartbeatAt })
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

describe("improvementRunLeases", () => {
  beforeEach(() => {
    db.delete(improvementRuns).run();
    db.delete(repos).run();
    db.delete(workers).run();
    db.insert(repos)
      .values({
        id: "repo-1",
        name: "repo-1",
        path: "/tmp/repo-1",
        defaultBranch: "main",
        createdAt: now(),
      })
      .run();
    insertRun({ id: RUN_ID });
    seedWorker("live-a", now());
    seedWorker("live-b", now());
  });

  it("lets one live worker claim; a second live worker and a re-claim are refused", () => {
    expect(improvementRunLeaseHolder(RUN_ID)).toBeNull();
    expect(claimImprovementRun(RUN_ID, "live-a", STALE_SECONDS)).toBe(true);
    expect(improvementRunLeaseHolder(RUN_ID)).toBe("live-a");
    expect(getRunRow(RUN_ID).heartbeatAt).not.toBeNull();

    expect(claimImprovementRun(RUN_ID, "live-b", STALE_SECONDS)).toBe(false);
    expect(claimImprovementRun(RUN_ID, "live-a", STALE_SECONDS)).toBe(false);
    expect(improvementRunLeaseHolder(RUN_ID)).toBe("live-a");
  });

  it("returns false for a missing run", () => {
    expect(claimImprovementRun("nope", "live-a", STALE_SECONDS)).toBe(false);
  });

  it("takes over a lease whose holder has gone stale", () => {
    expect(claimImprovementRun(RUN_ID, "live-a", STALE_SECONDS)).toBe(true);
    const stale = minutesAgo(10);
    db.update(workers).set({ heartbeatAt: stale }).where(eq(workers.id, "live-a")).run();
    db.update(improvementRuns)
      .set({ heartbeatAt: stale })
      .where(eq(improvementRuns.id, RUN_ID))
      .run();

    expect(claimImprovementRun(RUN_ID, "live-b", STALE_SECONDS)).toBe(true);
    expect(improvementRunLeaseHolder(RUN_ID)).toBe("live-b");
    expect(getRunRow(RUN_ID).heartbeatAt! > stale).toBe(true);
  });

  it("does not take over while the run heartbeat is fresh even if the worker row is stale", () => {
    expect(claimImprovementRun(RUN_ID, "live-a", STALE_SECONDS)).toBe(true);
    db.update(improvementRuns)
      .set({ heartbeatAt: minutesAgo(10) })
      .where(eq(improvementRuns.id, RUN_ID))
      .run();
    // Worker row still live but run heartbeat stale → holder not live.
    expect(claimImprovementRun(RUN_ID, "live-b", STALE_SECONDS)).toBe(true);
    expect(improvementRunLeaseHolder(RUN_ID)).toBe("live-b");
  });

  it("heartbeat succeeds only for the holder and advances heartbeatAt", () => {
    expect(claimImprovementRun(RUN_ID, "live-a", STALE_SECONDS)).toBe(true);
    const old = minutesAgo(1);
    db.update(improvementRuns)
      .set({ heartbeatAt: old })
      .where(eq(improvementRuns.id, RUN_ID))
      .run();

    expect(heartbeatImprovementRun(RUN_ID, "live-b")).toBe(false);
    expect(getRunRow(RUN_ID).heartbeatAt).toBe(old);

    expect(heartbeatImprovementRun(RUN_ID, "live-a")).toBe(true);
    expect(getRunRow(RUN_ID).heartbeatAt! > old).toBe(true);
  });

  it("release is a no-op for a non-holder and clears both columns for the holder", () => {
    expect(claimImprovementRun(RUN_ID, "live-a", STALE_SECONDS)).toBe(true);
    releaseImprovementRun(RUN_ID, "live-b");
    expect(improvementRunLeaseHolder(RUN_ID)).toBe("live-a");
    expect(getRunRow(RUN_ID).heartbeatAt).not.toBeNull();

    releaseImprovementRun(RUN_ID, "live-a");
    const row = getRunRow(RUN_ID);
    expect(row.workerId).toBeNull();
    expect(row.heartbeatAt).toBeNull();
  });

  it("cannot claim a run that is not running", () => {
    insertRun({ id: "run-done", status: "completed" });
    expect(claimImprovementRun("run-done", "live-a", STALE_SECONDS)).toBe(false);
    expect(improvementRunLeaseHolder("run-done")).toBeNull();
  });
});
