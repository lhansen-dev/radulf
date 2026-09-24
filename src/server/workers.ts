/**
 * Worker registry.
 *
 * One row in the `workers` table exists per live orchestrator process. Each
 * process registers itself on startup and refreshes its `heartbeatAt` on a
 * timer; a row whose `heartbeatAt` is older than the `workerStaleSeconds`
 * setting is considered dead and its claims are eligible for reaping.
 */
import os from "node:os";
import { eq, gte, lt } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, now, workers } from "@/db";

// How often a live worker process refreshes its `heartbeatAt`. Floored at
// 500ms so a misconfigured env value cannot hammer the database.
export const HEARTBEAT_INTERVAL_MS = Math.max(
  500,
  Number(process.env.RADULF_HEARTBEAT_INTERVAL_MS) || 5_000,
);

export type WorkerRow = typeof workers.$inferSelect;

/** Insert a row for this process and return its id. */
export function registerWorker(roles: string[]): string {
  const id = nanoid();
  const ts = now();
  db.insert(workers)
    .values({
      id,
      host: os.hostname(),
      pid: process.pid,
      roles: JSON.stringify(roles),
      startedAt: ts,
      heartbeatAt: ts,
    })
    .run();
  return id;
}

/** Refresh `heartbeatAt` for a live worker. */
export function heartbeatWorker(id: string): void {
  db.update(workers).set({ heartbeatAt: now() }).where(eq(workers.id, id)).run();
}

/** ISO timestamp `staleSeconds` ago; heartbeats older than this are dead. */
export function staleBefore(staleSeconds: number): string {
  return new Date(Date.now() - staleSeconds * 1000).toISOString();
}

export function liveWorkerIds(staleSeconds: number): Set<string> {
  const rows = db
    .select({ id: workers.id })
    .from(workers)
    .where(gte(workers.heartbeatAt, staleBefore(staleSeconds)))
    .all();
  return new Set(rows.map((r) => r.id));
}

export function staleWorkerIds(staleSeconds: number): string[] {
  return db
    .select({ id: workers.id })
    .from(workers)
    .where(lt(workers.heartbeatAt, staleBefore(staleSeconds)))
    .all()
    .map((r) => r.id);
}

export function deleteWorker(id: string): void {
  db.delete(workers).where(eq(workers.id, id)).run();
}

export function listWorkers(): WorkerRow[] {
  return db.select().from(workers).all();
}
