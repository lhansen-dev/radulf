/**
 * Improvement-run driver leases (spec 25 decision 7).
 *
 * An improvement run is driven by exactly one worker process at a time. The
 * lease lives on the `improvement_runs` row itself (`workerId`, `heartbeatAt`):
 * a worker claims a running run, refreshes its heartbeat while driving it and
 * releases it when done. A lease whose holder has gone stale — no worker
 * heartbeat AND no run heartbeat within the stale window — is considered
 * abandoned and may be taken over by another worker.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db, improvementRuns, now } from "@/db";
import { liveWorkerIds, staleBefore } from "./workers";

/**
 * Try to take the driver lease for `runId` on behalf of `workerId`.
 *
 * Returns false when the run is missing or not `running`, when `workerId`
 * already holds it (a lease is not re-entrant), or when another live worker
 * holds it. Otherwise the row is compare-and-set to `workerId` and true is
 * returned. Runs inside an immediate transaction so the read-then-write is
 * atomic across processes.
 */
export function claimImprovementRun(
  runId: string,
  workerId: string,
  staleSeconds: number,
): boolean {
  return db.transaction(
    (tx) => {
      const row = tx
        .select({
          id: improvementRuns.id,
          status: improvementRuns.status,
          workerId: improvementRuns.workerId,
          heartbeatAt: improvementRuns.heartbeatAt,
        })
        .from(improvementRuns)
        .where(eq(improvementRuns.id, runId))
        .get();
      if (!row || row.status !== "running") return false;
      if (row.workerId === workerId) return false;
      if (row.workerId !== null) {
        const holderLive =
          liveWorkerIds(staleSeconds).has(row.workerId) &&
          row.heartbeatAt !== null &&
          row.heartbeatAt >= staleBefore(staleSeconds);
        if (holderLive) return false;
      }
      const ts = now();
      const result = tx
        .update(improvementRuns)
        .set({ workerId, heartbeatAt: ts, updatedAt: ts })
        .where(
          and(
            eq(improvementRuns.id, runId),
            eq(improvementRuns.status, "running"),
            row.workerId === null
              ? isNull(improvementRuns.workerId)
              : eq(improvementRuns.workerId, row.workerId),
          ),
        )
        .run();
      return result.changes === 1;
    },
    { behavior: "immediate" },
  );
}

/**
 * Refresh the lease heartbeat on `runId`, but only if `workerId` still holds
 * it. Returns false when the lease has been taken away (the caller should
 * stop driving the run).
 */
export function heartbeatImprovementRun(runId: string, workerId: string): boolean {
  const result = db
    .update(improvementRuns)
    .set({ heartbeatAt: now() })
    .where(and(eq(improvementRuns.id, runId), eq(improvementRuns.workerId, workerId)))
    .run();
  return result.changes === 1;
}

/** Release the lease on `runId`, but only if `workerId` holds it. */
export function releaseImprovementRun(runId: string, workerId: string): void {
  db.update(improvementRuns)
    .set({ workerId: null, heartbeatAt: null })
    .where(and(eq(improvementRuns.id, runId), eq(improvementRuns.workerId, workerId)))
    .run();
}

/** Id of the worker driving `runId`, or null if nobody holds the lease. */
export function improvementRunLeaseHolder(runId: string): string | null {
  const row = db
    .select({ workerId: improvementRuns.workerId })
    .from(improvementRuns)
    .where(eq(improvementRuns.id, runId))
    .get();
  return row?.workerId ?? null;
}
