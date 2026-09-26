import path from "node:path";
import { desc, eq } from "drizzle-orm";
import { db, iterations, runs } from "@/db";
import { bus, type RalphEvent } from "./events";
import { runTranscriptDir } from "./retention";
import { startTranscriptPush } from "./transcript";

/**
 * Per-run live transcript watcher registry (spec 25 decision 5, as amended by
 * the operator: no client-interest protocol).
 *
 * The web process owns the watchers: exactly one `startTranscriptPush` per
 * running run per process — never one per connected client. In a split
 * web/worker deployment the worker writes the JSONL files and the web
 * process, which serves the SSE stream, tails them from here. The registry
 * is driven two ways: eagerly from the local `bus` (`run.started`,
 * `iteration.started`, `run.finished` — which the events tailer re-emits for
 * events inserted by another process) and by a periodic `syncTranscriptWatchers`
 * scan of the `runs` table as a safety net for anything the bus missed.
 *
 * This module never writes to the database.
 */

type Watcher = { iteration: number; stop: () => void };

// globalThis-backed like `bus` (src/server/events.ts): survive Next.js dev
// hot-reload with one registry per process.
const g = globalThis as unknown as {
  __radulfTranscriptWatchers?: Map<string, Watcher>;
  __radulfTranscriptWatchersStop?: () => void;
};
const watchers = (g.__radulfTranscriptWatchers ??= new Map<string, Watcher>());

/** Which transcript file a run is currently writing, or `null` when a loop
 * run has no iteration row yet (nothing to tail). */
export function transcriptTargetFor(run: {
  id: string;
  kind: "plan" | "loop" | "evaluate" | "critique";
}): { file: string; iteration: number } | null {
  if (run.kind === "plan") return { file: "plan.jsonl", iteration: 0 };
  if (run.kind === "evaluate") return { file: "evaluate.jsonl", iteration: 0 };
  if (run.kind === "critique") return { file: "critique.jsonl", iteration: 0 };
  const latest = db
    .select({ n: iterations.n })
    .from(iterations)
    .where(eq(iterations.runId, run.id))
    .orderBy(desc(iterations.n))
    .limit(1)
    .get();
  if (!latest) return null;
  return { file: `iter-${String(latest.n).padStart(3, "0")}.jsonl`, iteration: latest.n };
}

export function stopRunWatcher(runId: string): void {
  const existing = watchers.get(runId);
  if (!existing) return;
  watchers.delete(runId);
  existing.stop();
}

/** Bring the watcher for one run in line with the database: a run that is
 * running — or that already settled before this process heard about it, see
 * below — gets a watcher on its current transcript file; anything else loses
 * theirs.
 *
 * A settled run is still watched when reached from the bus, because the events
 * tailer reads the `events` table in batches and the `runs` row by then holds
 * today's status, not the status the event was written with. A fast run
 * therefore reaches a passive web process as one batch of
 * `run.started` … `run.finished` delivered after the run is over: refusing to
 * attach there meant such a run had no live transcript AT ALL for a client that
 * was connected the whole time — what made `make check-split` fail
 * intermittently (card 2026-09-26). Attaching is safe regardless: the attach
 * catches up from cursor 0 (src/server/transcript.ts), the `run.finished` that
 * follows in the same batch stops the watcher again, and the periodic scan
 * catches a `run.finished` that never arrives. `syncTranscriptWatchers` only
 * ever calls this for rows that are running, so a run this process has no news
 * about is never tailed. */
export function syncRunWatcher(runId: string): void {
  const run = db
    .select({ id: runs.id, kind: runs.kind, status: runs.status })
    .from(runs)
    .where(eq(runs.id, runId))
    .get();
  if (!run) {
    stopRunWatcher(runId);
    return;
  }
  const target = transcriptTargetFor(run);
  if (!target) {
    // A running loop run with no iteration row yet has nothing to tail and no
    // watcher to lose; a settled one is finished with whatever it had.
    if (run.status !== "running") stopRunWatcher(runId);
    return;
  }
  const existing = watchers.get(runId);
  if (existing && existing.iteration === target.iteration) return;
  stopRunWatcher(runId);
  watchers.set(runId, {
    iteration: target.iteration,
    stop: startTranscriptPush(path.join(runTranscriptDir(runId), target.file), runId, target.iteration),
  });
}

/** Full reconcile: every running run gets synced, every other watcher stops. */
export function syncTranscriptWatchers(): void {
  const running = db.select({ id: runs.id }).from(runs).where(eq(runs.status, "running")).all();
  const runningIds = new Set(running.map((row) => row.id));
  for (const id of runningIds) syncRunWatcher(id);
  for (const id of [...watchers.keys()]) {
    if (!runningIds.has(id)) stopRunWatcher(id);
  }
}

export function watchedTranscripts(): Array<{ runId: string; iteration: number }> {
  return [...watchers.entries()].map(([runId, watcher]) => ({ runId, iteration: watcher.iteration }));
}

export function stopAllTranscriptWatchers(): void {
  for (const id of [...watchers.keys()]) stopRunWatcher(id);
}

export function transcriptScanIntervalMs(): number {
  return Math.max(100, Number(process.env.RADULF_TRANSCRIPT_SCAN_INTERVAL_MS) || 5000);
}

/** Start the registry: bus-driven sync plus a periodic scan. Idempotent per
 * process; returns the stop for the already-running instance if there is one. */
export function startTranscriptWatchers(scanIntervalMs = transcriptScanIntervalMs()): () => void {
  if (g.__radulfTranscriptWatchersStop) return g.__radulfTranscriptWatchersStop;

  const handler = (row: RalphEvent) => {
    if (!row.runId) return;
    if (row.type === "run.started" || row.type === "iteration.started") syncRunWatcher(row.runId);
    else if (row.type === "run.finished") stopRunWatcher(row.runId);
  };
  bus.on("event", handler);
  syncTranscriptWatchers();
  const interval = setInterval(syncTranscriptWatchers, scanIntervalMs);
  interval.unref();

  const stop = () => {
    bus.off("event", handler);
    clearInterval(interval);
    stopAllTranscriptWatchers();
    delete g.__radulfTranscriptWatchersStop;
  };
  g.__radulfTranscriptWatchersStop = stop;
  return stop;
}
