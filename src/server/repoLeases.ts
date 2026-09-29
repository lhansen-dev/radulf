/**
 * Per-repo leases (spec 25 decision 6).
 *
 * One `repo_leases` row per repo path serializes review deliveries (approve /
 * retry-merge) across worker processes: a worker must hold the lease for a
 * repo before moving any of its refs. A lease held by a worker whose heartbeat
 * has gone stale is considered abandoned and may be taken over.
 */
import { eq, and, notInArray } from "drizzle-orm";
import { db, now, repoLeases } from "@/db";
import { liveWorkerIds } from "./workers";

/** A drizzle `db` or transaction handle; both expose the same query builders. */
type Queryable = Pick<typeof db, "select" | "insert">;

/**
 * Try to take the lease for `repoPath` on behalf of `workerId`.
 *
 * Returns false when a live worker (including `workerId` itself — a lease is
 * not re-entrant) already holds it; otherwise upserts the row and returns
 * true. Pass a transaction handle as `q` to make the read-then-write atomic.
 */
export function acquireRepoLease(
  repoPath: string,
  workerId: string,
  staleSeconds: number,
  q: Queryable = db,
): boolean {
  const existing = q.select().from(repoLeases).where(eq(repoLeases.repoPath, repoPath)).get();
  if (existing) {
    if (existing.workerId === workerId) return false;
    if (liveWorkerIds(staleSeconds).has(existing.workerId)) return false;
  }
  const acquiredAt = now();
  q.insert(repoLeases)
    .values({ repoPath, workerId, acquiredAt })
    .onConflictDoUpdate({ target: repoLeases.repoPath, set: { workerId, acquiredAt } })
    .run();
  return true;
}

/** Release the lease on `repoPath`, but only if `workerId` holds it. */
export function releaseRepoLease(repoPath: string, workerId: string): void {
  db.delete(repoLeases)
    .where(and(eq(repoLeases.repoPath, repoPath), eq(repoLeases.workerId, workerId)))
    .run();
}

/**
 * Delete every lease whose holder is not in `live`; returns the repo paths
 * that were freed.
 */
export function releaseStaleLeases(live: Set<string>): string[] {
  const ids = [...live];
  const stale = ids.length
    ? db.select().from(repoLeases).where(notInArray(repoLeases.workerId, ids)).all()
    : db.select().from(repoLeases).all();
  for (const row of stale) {
    db.delete(repoLeases).where(eq(repoLeases.repoPath, row.repoPath)).run();
  }
  return stale.map((r) => r.repoPath);
}

/**
 * Release every lease `workerId` holds — a worker handing back its own leases
 * on shutdown; returns the repo paths freed.
 */
export function releaseLeasesHeldBy(workerId: string): string[] {
  const held = db.select().from(repoLeases).where(eq(repoLeases.workerId, workerId)).all();
  for (const row of held) {
    db.delete(repoLeases).where(eq(repoLeases.repoPath, row.repoPath)).run();
  }
  return held.map((r) => r.repoPath);
}

/** Id of the worker holding the lease on `repoPath`, or null if it is free. */
export function leaseHolder(repoPath: string): string | null {
  const row = db
    .select({ workerId: repoLeases.workerId })
    .from(repoLeases)
    .where(eq(repoLeases.repoPath, repoPath))
    .get();
  return row?.workerId ?? null;
}
