import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray, isNotNull, isNull, lt, ne, or } from "drizzle-orm";
import { cards, db, events, repos, runs, settings, worktrees, TRANSCRIPTS_DIR } from "@/db";
import { planStatePath } from "./bookkeeping";
import { ClientError } from "./clientError";
import { FINISHED_STATUSES } from "./epics";
import { markWorktreeRemoved, removeWorktree } from "./git";
import { removeBaseline } from "./integrity";

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

/**
 * `rm -rf` a tree, reporting whether there was one. False on ENOENT, and
 * anything else still throws, exactly as the `existsSync` + `rmSync(force)`
 * pair it replaces did.
 *
 * Asynchronous because these trees are not small: a chatty run's transcripts
 * are thousands of JSONL files, and a worktree is a whole checkout. Done
 * synchronously that unlink storm is the entire event loop — every SSE
 * heartbeat, every orchestrator timer and every request stalled behind the
 * deletion of a run nobody is looking at. The sweep runs unattended on a
 * daily timer, so nothing is waiting on it to finish sooner.
 */
async function removeTree(target: string): Promise<boolean> {
  try {
    await fs.promises.rm(/* turbopackIgnore: true */ target, { recursive: true });
    return true;
  } catch (cause) {
    if ((cause as { code?: string }).code === "ENOENT") return false;
    throw cause;
  }
}

/** The `settings` key holding the UTC day the retention sweep last ran on.
 * A plain key/value row; `getSettings()` ignores keys it does not know. */
export const RETENTION_SWEEP_MARKER_KEY = "retentionSweepDay";

/** The UTC calendar day (`YYYY-MM-DD`) a sweep at `at` belongs to. */
export function sweepDayKey(at = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Claim today's retention sweep (spec 25 decision 7). Every worker runs the
 * sweep timer; this compare-and-set on the marker row decides which one
 * prunes. The upsert only writes when the stored day differs from today's,
 * so the first worker to call on a given UTC day sees one changed row and
 * returns true, and every later caller that day sees zero and returns false.
 */
export function claimDailySweep(at = new Date()): boolean {
  const value = sweepDayKey(at);
  const result = db
    .insert(settings)
    .values({ key: RETENTION_SWEEP_MARKER_KEY, value })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value },
      setWhere: ne(settings.value, value),
    })
    .run();
  return result.changes === 1;
}

export async function removeRunTranscripts(runIds: string[]): Promise<number> {
  let removed = 0;
  for (const runId of new Set(runIds)) {
    if (await removeTree(runTranscriptDir(runId))) removed += 1;
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
  await removeRunTranscripts(runIds);
  fs.rmSync(/* turbopackIgnore: true */ planStatePath(cardId), { force: true });
}

/** Reclaim the worktree, branch, `worktrees` row and integrity baseline of
 * every finished (done/abandoned) card. Two ways they get left behind: a
 * web-only process abandons a card without ever touching the repository
 * (reviewService.abandon, spec 25), and a delivery worker that died between
 * finishing the card and removing its worktree — after `completeApproval` had
 * already moved the card to `done` — leaves the same things behind. Either way
 * a worker reclaims them here, on its pump tick. Safe to repeat and to run
 * from several workers: `removeWorktree` swallows a worktree or branch that is
 * already gone, the row stamp and `removeBaseline` are no-ops the second time. */
export async function removeFinishedWorktrees(): Promise<number> {
  const rows = db
    .select({
      path: worktrees.path,
      branch: worktrees.branch,
      repoPath: repos.path,
      runId: worktrees.runId,
    })
    .from(worktrees)
    .innerJoin(runs, eq(worktrees.runId, runs.id))
    .innerJoin(cards, eq(runs.cardId, cards.id))
    .innerJoin(repos, eq(worktrees.repoId, repos.id))
    .where(and(isNull(worktrees.removedAt), inArray(cards.status, [...FINISHED_STATUSES])))
    .all();
  for (const row of rows) {
    // The order matters: `removeWorktree` stamps `removedAt` and this sweep
    // only selects `removedAt IS NULL`, so a baseline deleted afterwards would
    // be stranded forever if the process died — or the deletion threw — in
    // between. Baseline first keeps the row retryable, matching
    // `completeApproval` in reviewService.ts.
    if (row.runId !== null) removeBaseline(row.runId);
    await removeWorktree(row.repoPath, row.path, row.branch);
  }
  return rows.length;
}

/** Delete terminal run history/events older than the requested window and
 * clean aged orphan/standalone transcript entries. Cards and plans remain.
 * Only runs and events of finished (done/abandoned) cards are pruned: an
 * unfinished card — waiting in review or needs_attention, or mid-cycle —
 * reuses its runs' worktree and finds it again through those rows
 * (latestWorktreeRun), and its events still hold state the UI and the stale
 * sweep read back. Card-less events age out on the cutoff alone. */
export async function pruneRuntimeHistory(olderThanDays: number): Promise<CleanupResult> {
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
  let transcriptEntriesDeleted = await removeRunTranscripts(runIds);

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
    if (!(await removeTree(worktreePath))) continue;
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
  for (const entry of await readTranscriptEntries()) {
    if (entry.isDirectory() && liveRunIds.has(entry.name)) continue;
    const entryPath = path.join(/* turbopackIgnore: true */ TRANSCRIPTS_DIR, entry.name);
    const stat = await fs.promises.stat(/* turbopackIgnore: true */ entryPath);
    if (stat.mtimeMs >= cutoffMs) continue;
    if (await removeTree(entryPath)) transcriptEntriesDeleted += 1;
  }

  return { runsDeleted: runIds.length, eventsDeleted, transcriptEntriesDeleted, worktreesRemoved };
}

/** The transcripts root's children, or none when it does not exist yet. */
async function readTranscriptEntries(): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(/* turbopackIgnore: true */ TRANSCRIPTS_DIR, {
      withFileTypes: true,
    });
  } catch (cause) {
    if ((cause as { code?: string }).code === "ENOENT") return [];
    throw cause;
  }
}
