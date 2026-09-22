import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import { cards, db, events, runs, TRANSCRIPTS_DIR } from "@/db";
import { planStatePath } from "./bookkeeping";
import { ClientError } from "./clientError";
import { markWorktreeRemoved, removeWorktree } from "./git";

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

/** What a card leaves on disk: the run whose worktree still exists, if any
 * (latestWorktreeRun), the ids of every run for its transcripts, and the
 * orchestrator-private plan checklist. */
export type CardArtifacts = {
  cardId: string;
  worktreeRun: { worktreePath: string; branch: string } | undefined;
  runIds: string[];
};

/** The disk half of deleting a card. Callers gather the artifacts themselves,
 * because deleting a repo has to do so before its cards' rows cascade away. */
export async function removeCardArtifacts(repoPath: string, artifacts: CardArtifacts): Promise<void> {
  const { cardId, worktreeRun, runIds } = artifacts;
  if (worktreeRun) await removeWorktree(repoPath, worktreeRun.worktreePath, worktreeRun.branch);
  removeRunTranscripts(runIds);
  fs.rmSync(/* turbopackIgnore: true */ planStatePath(cardId), { force: true });
}

/** Delete terminal run history/events older than the requested window and
 * clean aged orphan/standalone transcript entries. Cards and plans remain.
 * Only runs and events of finished (done/abandoned) cards are pruned: an
 * unfinished card — waiting in review or needs_attention, or mid-cycle —
 * reuses its runs' worktree and finds it again through those rows
 * (latestWorktreeRun), and its events still hold state the UI and the stale
 * sweep read back. Card-less events age out on the cutoff alone. */
export function pruneRuntimeHistory(olderThanDays: number): CleanupResult {
  if (!Number.isInteger(olderThanDays) || olderThanDays < 1 || olderThanDays > 3_650) {
    throw new ClientError("olderThanDays must be an integer between 1 and 3650");
  }
  const cutoffMs = Date.now() - olderThanDays * 86_400_000;
  const cutoff = new Date(cutoffMs).toISOString();
  const oldRuns = db
    .select({ id: runs.id, worktreePath: runs.worktreePath })
    .from(runs)
    .innerJoin(cards, eq(runs.cardId, cards.id))
    .where(
      and(
        isNotNull(runs.endedAt),
        lt(runs.endedAt, cutoff),
        inArray(cards.status, ["done", "abandoned"]),
      ),
    )
    .all();
  const runIds = oldRuns.map((run) => run.id);
  let transcriptEntriesDeleted = removeRunTranscripts(runIds);

  // Close the worktree-directory leak: a crashed run gets endedAt stamped by
  // recover() same as any normal finish, ages past the cutoff, and its row
  // is deleted below — reclaim the directory here before that happens, since
  // nothing else ever revisits a dead run's worktreePath. Runs share a
  // worktree across a card's cycle, so a directory a retained run still
  // references stays.
  if (runIds.length > 0) db.delete(runs).where(inArray(runs.id, runIds)).run();
  const retainedPaths = new Set(
    db.select({ worktreePath: runs.worktreePath }).from(runs).all().map((run) => run.worktreePath),
  );
  let worktreesRemoved = 0;
  for (const worktreePath of new Set(oldRuns.map((run) => run.worktreePath))) {
    if (retainedPaths.has(worktreePath)) continue;
    if (!fs.existsSync(/* turbopackIgnore: true */ worktreePath)) continue;
    fs.rmSync(/* turbopackIgnore: true */ worktreePath, { recursive: true, force: true });
    markWorktreeRemoved(worktreePath);
    worktreesRemoved += 1;
  }

  // Scoped to finished cards for the same reason the run sweep above is, and
  // it was not: an unfinished card's events are not history, they are state.
  // `install.gate` carries the only copy of the unapproved lifecycle scripts
  // the operator has to read before they can approve them, `plan.questions`
  // the planner's blocking questions, and `sweepStaleAttention` anchors on the
  // `card.moved` that put a card into Needs Attention — delete that and the
  // card is never announced as waiting again, which is precisely the card the
  // sweep exists for. Cards parked long enough to age past a cutoff are the
  // ones this hurt.
  //
  // Events with no card (improvement-run lifecycle, server restarts) age out
  // on the cutoff alone, as before — nothing is waiting on them.
  const finishedCardIds = db
    .select({ id: cards.id })
    .from(cards)
    .where(inArray(cards.status, ["done", "abandoned"]))
    .all()
    .map((card) => card.id);
  const eventsDeleted = db
    .delete(events)
    .where(
      and(
        lt(events.createdAt, cutoff),
        or(isNull(events.cardId), inArray(events.cardId, finishedCardIds)),
      ),
    )
    .run().changes;

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
