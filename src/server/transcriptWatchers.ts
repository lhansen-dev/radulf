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

/** Bring the watcher for one run in line with the database: running runs get
 * a watcher on their current transcript file, anything else loses theirs. */
export function syncRunWatcher(runId: string): void {
  const run = db
    .select({ id: runs.id, kind: runs.kind, status: runs.status })
    .from(runs)
    .where(eq(runs.id, runId))
    .get();
  if (!run || run.status !== "running") {
    stopRunWatcher(runId);
    return;
  }
  const target = transcriptTargetFor(run);
  if (!target) return;
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
