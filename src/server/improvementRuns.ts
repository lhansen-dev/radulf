import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  db,
  now,
  cards,
  improvementRuns,
  type CardStatus,
  type ImprovementRunStatus,
} from "@/db";
import { bus, emitEvent, type RalphEvent } from "./events";
import { postAlert } from "./alerts";
import { getSettings } from "./settings";
import { normalizeProvider } from "./providers";
import { getOrchestrator } from "./orchestrator";
import { proposeOneImprovement, type Proposal } from "./improvementProposer";
import { assertBranchExists, git, isRalphBranch } from "./git";
import { ClientError } from "./clientError";
import { getCard } from "./cards";
import { getRepo } from "./repos";
import { hasRole } from "./roles";
import {
  claimImprovementRun,
  heartbeatImprovementRun,
  releaseImprovementRun,
} from "./improvementRunLeases";
import { HEARTBEAT_INTERVAL_MS } from "./workers";
import { sleep } from "@/shared/sleep";
import { errorMessage } from "@/shared/errorMessage";

export type ImprovementRun = typeof improvementRuns.$inferSelect;

export type CreateImprovementRunInput = {
  repoId: string;
  baseBranch: string;
  /** Run-level wall-clock budget, in minutes. */
  budgetMinutes: number;
  focusPrompt?: string | null;
  plannerModel?: string | null;
  loopModel?: string | null;
  evaluatorModel?: string | null;
  plannerReasoning?: string | null;
  loopReasoning?: string | null;
  evaluatorReasoning?: string | null;
  maxIterations?: number | null;
  timeoutMinutes?: number | null;
};

// A card reaches one of these statuses and never leaves it without a human
// (or another explicit start) acting on it — the driver's signal that its
// in-flight task is over (decision 3). Cancelling is a human acting on it
// too: cancelCard parks the card in "backlog", which auto-mode's pump()
// never claims back out from under the driver.
function isTerminalCardStatus(status: CardStatus): boolean {
  return (
    status === "done" ||
    status === "needs_attention" ||
    status === "abandoned" ||
    status === "backlog"
  );
}

// Repeated dry proposer passes (nothing left worth proposing, or a flaky
// planner) end the run rather than spinning until the deadline.
const EMPTY_PROPOSAL_LIMIT = 3;
const EMPTY_PROPOSAL_BACKOFF_MS = 15_000;

function getRun(runId: string): ImprovementRun | undefined {
  return db.select().from(improvementRuns).where(eq(improvementRuns.id, runId)).get();
}

function activeRunForRepo(repoId: string): ImprovementRun | undefined {
  return db
    .select()
    .from(improvementRuns)
    .where(and(eq(improvementRuns.repoId, repoId), eq(improvementRuns.status, "running")))
    .get();
}

/** Every card this run has created so far, keyed off its unique feature
 * branch (N1) — no separate join table needed. */
function priorCardTitles(run: ImprovementRun): string[] {
  return db
    .select({ title: cards.title })
    .from(cards)
    .where(eq(cards.baseBranch, run.featureBranch))
    .all()
    .map((r) => r.title);
}

// globalThis-backed, mirroring the orchestrator singleton pattern (N3): a
// driver must run at most once per process per run, and survive Next.js dev
// hot-reload without losing track of which runs are already being driven.
const g = globalThis as unknown as {
  __radulfImprovementDrivers?: Set<string>;
};

function driverGuard(): Set<string> {
  return (g.__radulfImprovementDrivers ??= new Set());
}

/**
 * Block until `cardId` reaches a terminal status (N2) or is deleted out from
 * under the driver. Resolves on whichever fires first: a `bus` event naming
 * this card whose current DB status is already terminal, or a periodic poll
 * (belt-and-braces — the in-process bus is the primary signal, matching the
 * pattern the SSE stream itself relies on). Resolves `null` for a deleted
 * card — it has no status to report, and null is never "done".
 */
export function awaitCardTerminal(cardId: string, pollMs = 2_000): Promise<CardStatus | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (status: CardStatus | null) => {
      if (settled) return;
      settled = true;
      bus.off("event", onEvent);
      clearInterval(timer);
      resolve(status);
    };
    const check = () => {
      if (settled) return;
      const card = getCard(cardId);
      if (!card) {
        finish(null);
        return;
      }
      if (isTerminalCardStatus(card.status)) finish(card.status);
    };
    const onEvent = (row: RalphEvent) => {
      if (row.cardId === cardId) check();
    };
    bus.on("event", onEvent);
    const timer = setInterval(check, pollMs);
    timer.unref?.();
    check();
  });
}

/** Active + recent runs for the board (most recent first, capped). */
export function listImprovementRuns(limit = 20): ImprovementRun[] {
  return db
    .select()
    .from(improvementRuns)
    .orderBy(desc(improvementRuns.createdAt))
    .limit(limit)
    .all();
}

/**
 * Create an improvement run: cut its feature branch off `baseBranch` (N4),
 * persist the run row, and kick off its driver. Enforces one active run per
 * repo (decision 6).
 */
export async function createImprovementRun(
  input: CreateImprovementRunInput,
): Promise<ImprovementRun> {
  const repo = getRepo(input.repoId);
  if (!repo) throw new ClientError("repoId does not exist");
  // The same rule card creation applies (spec 19): a run cut off one of
  // Radulf's own branches would accumulate onto another run's or card's work.
  if (isRalphBranch(input.baseBranch)) {
    throw new ClientError("baseBranch cannot be one of Radulf's own ralph/* branches");
  }
  await assertBranchExists(repo.path, input.baseBranch, "baseBranch");

  const featureBranch = `ralph/improve-${Date.now()}`;
  // Claim the repo's single slot and write the row without an `await`
  // between the two. The check used to sit above the branch-existence
  // check and the `git branch` call, so two POSTs arriving together both
  // saw no active run, both got a run row, and decision 6's one-active-per-
  // repo rule held only for requests far enough apart. Nothing can
  // interleave inside a synchronous block, and better-sqlite3 is
  // synchronous, so this is the whole fix.
  const row = db.transaction((tx) => {
    if (activeRunForRepo(input.repoId)) {
      throw new ClientError("an improvement run is already active for this repo");
    }
    return tx
      .insert(improvementRuns)
      .values({
        id: nanoid(),
        repoId: input.repoId,
        status: "running",
        featureBranch,
        baseBranch: input.baseBranch,
        focusPrompt: input.focusPrompt ?? null,
        plannerModel: input.plannerModel ?? null,
        loopModel: input.loopModel ?? null,
        evaluatorModel: input.evaluatorModel ?? null,
        plannerReasoning: input.plannerReasoning ?? null,
        loopReasoning: input.loopReasoning ?? null,
        evaluatorReasoning: input.evaluatorReasoning ?? null,
        maxIterations: input.maxIterations ?? null,
        timeoutMinutes: input.timeoutMinutes ?? null,
        deadlineAt: new Date(Date.now() + input.budgetMinutes * 60_000).toISOString(),
        createdAt: now(),
        updatedAt: now(),
      })
      .returning()
      .get();
  });

  // Cutting the branch after the claim, rather than before it, means a
  // rejected second request leaves no stray `ralph/improve-*` behind. A
  // failure here does, so give the slot back.
  try {
    await git(repo.path, "branch", featureBranch, input.baseBranch);
  } catch (cause) {
    db.delete(improvementRuns).where(eq(improvementRuns.id, row.id)).run();
    throw cause;
  }

  emitEvent("improvement.started", { payload: { runId: row.id, featureBranch } });
  // A web-only process (spec 25: RADULF_ROLES=web) only inserts the row and
  // emits `improvement.started`; the worker adopts the still-`running` row
  // from its pump timer via resumeImprovementRuns(). A pi session must never
  // be constructed in a web-only process.
  if (hasRole("worker")) void driveRun(row.id);
  return row;
}

/** Soft-stop (decision/ruling 5): the deadline moves to now, so the driver
 * stops proposing new work the next time it checks between tasks — a task
 * already in flight finishes untouched. `stopRequestedAt` is what tells the
 * driver — in this process or in the worker that holds the run's lease — that
 * the deadline was an operator's Stop and not the budget elapsing. */
export function stopImprovementRun(runId: string): ImprovementRun {
  const run = getRun(runId);
  if (!run) throw new ClientError("improvement run not found", 404);
  if (run.status !== "running") throw new ClientError(`cannot stop a ${run.status} run`);
  return db
    .update(improvementRuns)
    .set({ deadlineAt: now(), stopRequestedAt: now(), updatedAt: now() })
    .where(eq(improvementRuns.id, runId))
    .returning()
    .get();
}

/** Restart drivers for every run still `running` (N3). Called at boot — after
 * `getOrchestrator()` so `recover()` has already flipped any orphaned card to
 * `needs_attention` — and again on every worker pump tick, adopting runs a
 * web-only process created (spec 25: web only inserts the row). Each run is
 * claimed through its driver lease (spec 25 decision 7): `driveRun` returns at
 * once for a run this process already drives or another live worker holds,
 * and a run whose driver went stale is adopted by whichever worker's pump tick
 * claims it first. Fire-and-forget — a run's driver can legitimately outlive
 * the whole time budget, so this must never block startup or the pump. */
export function resumeImprovementRuns(): void {
  const running = db.select().from(improvementRuns).where(eq(improvementRuns.status, "running")).all();
  for (const run of running) void driveRun(run.id);
}

function finishRun(
  runId: string,
  status: Exclude<ImprovementRunStatus, "running">,
  reason: string,
): void {
  const run = getRun(runId);
  if (!run || run.status !== "running") return;
  db.update(improvementRuns)
    .set({ status, endedAt: now(), updatedAt: now(), currentCardId: null })
    .where(eq(improvementRuns.id, runId))
    .run();
  emitEvent("improvement.completed", {
    payload: {
      runId,
      featureBranch: run.featureBranch,
      tasksSucceeded: run.tasksSucceeded,
      status,
      reason,
    },
  });
  // A run outlives the tab that started it by design — it holds a wall-clock
  // budget measured in hours — so the branch waiting to be reviewed at the end
  // of one is exactly the news that has to leave the machine.
  if (getSettings().alertOnImprovementRunFinished) {
    void postAlert({
      type: "improvement.completed",
      title: `Improvement run ${status} on ${run.featureBranch}`,
      message: `${run.tasksSucceeded} task${run.tasksSucceeded === 1 ? "" : "s"} landed. ${reason}`.trim(),
      url: "/",
    });
  }
}

/** The run ran out of time or work: "stopped" when an operator asked for
 * it, "completed" when the deadline simply arrived. */
function endRun(runId: string, reason: string): void {
  finishRun(runId, getRun(runId)?.stopRequestedAt ? "stopped" : "completed", reason);
}

/** Record a just-finished task's outcome (decision 3): success resets the
 * consecutive-failure counter; a failure increments it and stops the run
 * once it hits 3 in a row. */
function recordCardOutcome(runId: string, success: boolean): void {
  const run = getRun(runId);
  if (!run) return;
  const consecutiveFailures = success ? 0 : run.consecutiveFailures + 1;
  db.update(improvementRuns)
    .set({
      tasksSucceeded: run.tasksSucceeded + (success ? 1 : 0),
      consecutiveFailures,
      currentCardId: null,
      updatedAt: now(),
    })
    .where(eq(improvementRuns.id, runId))
    .run();
  if (!success && consecutiveFailures >= 3) {
    finishRun(runId, "failed", "3 consecutive task failures");
  }
}

/** Guarded entry point: a run is driven by exactly one worker at a time
 * (spec 25 decision 7). The in-process guard set (N3) still protects against
 * Next.js dev hot-reload double-driving within one process; across processes
 * the run is claimed through its lease on the `improvement_runs` row
 * (`workerId`/`heartbeatAt`), heartbeated every `HEARTBEAT_INTERVAL_MS` while
 * driving and released when the driver returns. A claim fails when another
 * live worker holds the lease; a run whose driver went stale is adopted by
 * whichever worker's pump tick claims it first. Never throws — an unexpected
 * failure lands the run in `failed` rather than an unhandled rejection, so
 * callers can always fire-and-forget. */
export async function driveRun(
  runId: string,
  workerId: string = getOrchestrator().workerId,
): Promise<void> {
  const drivers = driverGuard();
  if (drivers.has(runId)) return;
  drivers.add(runId);
  if (!claimImprovementRun(runId, workerId, getSettings().workerStaleSeconds)) {
    drivers.delete(runId);
    return;
  }
  const beat = setInterval(() => {
    heartbeatImprovementRun(runId, workerId);
  }, HEARTBEAT_INTERVAL_MS);
  beat.unref?.();
  try {
    await runDriverLoop(runId, workerId);
  } finally {
    clearInterval(beat);
    releaseImprovementRun(runId, workerId);
    drivers.delete(runId);
  }
}

async function runDriverLoop(runId: string, workerId: string): Promise<void> {
  let emptyStreak = 0;
  try {
    for (;;) {
      const run = getRun(runId);
      if (!run || run.status !== "running") return;
      // Another worker took the lease over while this one was stale — it is
      // the driver now; stop touching the run.
      if (run.workerId !== workerId) return;

      // Resume path (N3): reattach to an in-flight card before doing
      // anything else. A card `recover()` already flipped to a terminal
      // status (or one that finished between the crash and this restart)
      // is reconciled immediately; anything still non-terminal (queued
      // ready/todo/needs_attention, or genuinely still running in this
      // process) is simply awaited again.
      if (run.currentCardId) {
        const card = getCard(run.currentCardId);
        if (!card) {
          recordCardOutcome(runId, false);
          continue;
        }
        if (isTerminalCardStatus(card.status)) {
          recordCardOutcome(runId, card.status === "done");
          continue;
        }
        if (card.status === "todo" || card.status === "needs_attention") {
          try {
            getOrchestrator().startCard(card.id);
          } catch {
            // Lost a race with another transition — awaitCardTerminal below
            // still resolves once it lands somewhere terminal.
          }
        }
        recordCardOutcome(runId, (await awaitCardTerminal(card.id)) === "done");
        continue;
      }

      // Timer is a soft gate, checked only between tasks (decision/ruling 5).
      if (Date.now() >= Date.parse(run.deadlineAt)) {
        endRun(runId, "deadline reached");
        return;
      }

      const repo = getRepo(run.repoId);
      if (!repo) {
        finishRun(runId, "failed", "repo no longer exists");
        return;
      }

      const settings = getSettings();
      let proposal: Proposal | null;
      try {
        proposal = await proposeOneImprovement({
          repo: { path: repo.path },
          featureBranch: run.featureBranch,
          focusPrompt: run.focusPrompt,
          priorTitles: priorCardTitles(run),
          plannerProvider: normalizeProvider(settings.plannerProvider, "anthropic"),
          plannerModel: run.plannerModel || settings.plannerModel,
          plannerReasoningLevel: run.plannerReasoning || settings.plannerReasoningLevel,
          template: settings.improvePromptTemplate,
        });
      } catch {
        proposal = null;
      }

      if (!proposal) {
        emptyStreak += 1;
        if (emptyStreak >= EMPTY_PROPOSAL_LIMIT) {
          endRun(runId, "proposer ran dry");
          return;
        }
        await sleep(EMPTY_PROPOSAL_BACKOFF_MS);
        continue;
      }
      emptyStreak = 0;

      // Each card's timeout is additionally capped at the remaining budget
      // (ruling 5). Re-read the run: `run` was loaded before the proposer pass,
      // which takes minutes, and a Stop landing in that window only moves
      // `deadlineAt` in the DB. Trusting the stale snapshot let an observed live
      // run spawn a whole extra card 6.5 minutes *after* it had been stopped.
      const fresh = getRun(runId) ?? run;
      const remainingMinutes = Math.floor((Date.parse(fresh.deadlineAt) - Date.now()) / 60_000);
      if (remainingMinutes < 1) {
        endRun(runId, "deadline reached");
        return;
      }
      const timeoutMinutes = Math.min(
        fresh.timeoutMinutes ?? settings.defaultTimeoutMinutes,
        remainingMinutes,
      );

      const cardId = nanoid();
      db.insert(cards)
        .values({
          id: cardId,
          repoId: run.repoId,
          title: proposal.title,
          description: proposal.description,
          status: "todo",
          source: "agent",
          autoApprove: 1,
          baseBranch: run.featureBranch,
          maxIterations: run.maxIterations,
          timeoutMinutes,
          plannerModel: run.plannerModel,
          loopModel: run.loopModel,
          evaluatorModel: run.evaluatorModel,
          createdAt: now(),
          updatedAt: now(),
        })
        .run();
      emitEvent("card.created", { cardId, payload: { title: proposal.title } });
      db.update(improvementRuns)
        .set({ currentCardId: cardId, tasksCreated: run.tasksCreated + 1, updatedAt: now() })
        .where(eq(improvementRuns.id, runId))
        .run();

      try {
        getOrchestrator().startCard(cardId);
      } catch {
        // Same as above — awaitCardTerminal is the source of truth.
      }
      recordCardOutcome(runId, (await awaitCardTerminal(cardId)) === "done");
    }
  } catch (e) {
    finishRun(runId, "failed", `improvement run crashed: ${errorMessage(e)}`);
  }
}
