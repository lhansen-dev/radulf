import { asc, gt, max } from "drizzle-orm";
import { db, events } from "@/db";
import { bus, forgetLocalEventsThrough, wasEmittedLocally, type RalphEvent } from "./events";

/**
 * Events tailer — the spec 25 decision 5 fan-out seam.
 *
 * When Radulf runs as split web/worker processes, `emitEvent` in one process
 * only reaches that process's in-memory `bus`. The tailer polls the `events`
 * table (the durable copy every process shares) and re-emits any row it has
 * not seen on the local `bus`, skipping ids this process emitted itself so
 * local listeners never receive an event twice. It is read-only: it never
 * inserts, updates, or deletes.
 *
 * This is deliberately a simple polling seam; a later multi-host spec
 * replaces it with a proper cross-host transport.
 */

/** Highest `events.id` currently in the table, or 0 when empty. */
export function latestEventId(): number {
  const row = db.select({ maxId: max(events.id) }).from(events).get();
  return row?.maxId ?? 0;
}

/**
 * One poll: emit every row with `id > state.lastId` that this process did not
 * emit itself, advance `state.lastId`, and prune the local-emit set. Returns
 * the rows it emitted. DB errors are logged rather than thrown so a transient
 * failure never kills the interval.
 */
export function tailEventsOnce(state: { lastId: number }): RalphEvent[] {
  const emitted: RalphEvent[] = [];
  try {
    const rows = db
      .select()
      .from(events)
      .where(gt(events.id, state.lastId))
      .orderBy(asc(events.id))
      .all() as RalphEvent[];
    if (rows.length === 0) return emitted;
    for (const row of rows) {
      if (wasEmittedLocally(row.id)) continue;
      bus.emit("event", row);
      emitted.push(row);
    }
    state.lastId = rows[rows.length - 1].id;
    forgetLocalEventsThrough(state.lastId);
  } catch (err) {
    console.error("[eventsTail] poll failed:", err);
  }
  return emitted;
}

export function eventsTailIntervalMs(): number {
  return Math.max(50, Number(process.env.RADULF_EVENTS_TAIL_INTERVAL_MS) || 500);
}

const g = globalThis as unknown as { __radulfEventsTailStop?: () => void };

/**
 * Start polling the `events` table. One tailer per process: if one is already
 * running (globalThis-backed to survive Next.js dev hot-reload), returns its
 * stop function without starting another. The returned stop clears the
 * interval and the singleton so a later `startEventsTail` can start fresh.
 */
export function startEventsTail(intervalMs = eventsTailIntervalMs()): () => void {
  if (g.__radulfEventsTailStop) return g.__radulfEventsTailStop;
  const state = { lastId: latestEventId() };
  const timer = setInterval(() => tailEventsOnce(state), intervalMs);
  timer.unref();
  const stop = () => {
    clearInterval(timer);
    if (g.__radulfEventsTailStop === stop) delete g.__radulfEventsTailStop;
  };
  g.__radulfEventsTailStop = stop;
  return stop;
}
