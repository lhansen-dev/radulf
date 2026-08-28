import fs from "node:fs";
import path from "node:path";
import { and, inArray, isNotNull, lt } from "drizzle-orm";
import { db, events, runs, TRANSCRIPTS_DIR } from "@/db";
import { ClientError } from "./clientError";
import { markWorktreeRemoved } from "./git";

export type CleanupResult = {
  runsDeleted: number;
  eventsDeleted: number;
  transcriptEntriesDeleted: number;
  worktreesRemoved: number;
};

/** The directory a run's transcripts live in — always under TRANSCRIPTS_DIR
 * so RADULF_DATA_DIR moves reads, writes, and pruning together. */
export function runTranscriptDir(runId: string): string {
  return path.join(/* turbopackIgnore: true */ TRANSCRIPTS_DIR, runId);
}

export function removeRunTranscripts(runIds: string[]): number {
  let removed = 0;
  for (const runId of new Set(runIds)) {
    const transcriptDir = runTranscriptDir(runId);
    if (!fs.existsSync(/* turbopackIgnore: true */ transcriptDir)) continue;
    fs.rmSync(/* turbopackIgnore: true */ transcriptDir, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/** Delete terminal run history/events older than the requested window and
 * clean aged orphan/standalone transcript entries. Cards and plans remain. */
export function pruneRuntimeHistory(olderThanDays: number): CleanupResult {
  if (!Number.isInteger(olderThanDays) || olderThanDays < 1 || olderThanDays > 3_650) {
    throw new ClientError("olderThanDays must be an integer between 1 and 3650");
  }
  const cutoffMs = Date.now() - olderThanDays * 86_400_000;
  const cutoff = new Date(cutoffMs).toISOString();
  const oldRuns = db
    .select({ id: runs.id, worktreePath: runs.worktreePath })
    .from(runs)
    .where(and(isNotNull(runs.endedAt), lt(runs.endedAt, cutoff)))
    .all();
  const runIds = oldRuns.map((run) => run.id);
  let transcriptEntriesDeleted = removeRunTranscripts(runIds);

  // Close the worktree-directory leak: a crashed run gets endedAt stamped by
  // recover() same as any normal finish, ages past the cutoff, and its row
  // is deleted below — reclaim the directory here before that happens, since
  // nothing else ever revisits a dead run's worktreePath.
  let worktreesRemoved = 0;
  for (const worktreePath of new Set(oldRuns.map((run) => run.worktreePath))) {
    if (!fs.existsSync(/* turbopackIgnore: true */ worktreePath)) continue;
    fs.rmSync(/* turbopackIgnore: true */ worktreePath, { recursive: true, force: true });
    markWorktreeRemoved(worktreePath);
    worktreesRemoved += 1;
  }

  if (runIds.length > 0) db.delete(runs).where(inArray(runs.id, runIds)).run();
  const eventsDeleted = db.delete(events).where(lt(events.createdAt, cutoff)).run().changes;

  const liveRunIds = new Set(db.select({ id: runs.id }).from(runs).all().map((run) => run.id));
  if (fs.existsSync(/* turbopackIgnore: true */ TRANSCRIPTS_DIR)) {
    for (const entry of fs.readdirSync(/* turbopackIgnore: true */ TRANSCRIPTS_DIR, {
      withFileTypes: true,
    })) {
      if (entry.isDirectory() && liveRunIds.has(entry.name)) continue;
      const entryPath = path.join(/* turbopackIgnore: true */ TRANSCRIPTS_DIR, entry.name);
      const stat = fs.statSync(/* turbopackIgnore: true */ entryPath);
      if (stat.mtimeMs >= cutoffMs) continue;
      fs.rmSync(/* turbopackIgnore: true */ entryPath, { recursive: true, force: true });
      transcriptEntriesDeleted += 1;
    }
  }

  return { runsDeleted: runIds.length, eventsDeleted, transcriptEntriesDeleted, worktreesRemoved };
}
