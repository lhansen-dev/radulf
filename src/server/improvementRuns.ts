import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  db,
  now,
  cards,
  repos,
  improvementRuns,
  type CardStatus,
  type ImprovementRunStatus,
} from "@/db";
import { bus, emitEvent, type RalphEvent } from "./events";
import { getSettings } from "./settings";
import { normalizeProvider } from "./providers";
import { getOrchestrator } from "./orchestrator";
import { proposeOneImprovement } from "./improvementProposer";
import type { Proposal } from "./pm";
import { git, listBranches } from "./git";
import { ClientError } from "./clientError";

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

// A card reaches one of these three statuses and never leaves it without a
// human (or another explicit start) acting on it — the driver's signal that
// its in-flight task is over (decision 3).
function isTerminalCardStatus(status: CardStatus): boolean {
  return status === "done" || status === "needs_attention" || status === "abandoned";
}

// Repeated dry proposer passes (nothing left worth proposing, or a flaky
// planner) end the run rather than spinning until the deadline.
const EMPTY_PROPOSAL_LIMIT = 3;
const EMPTY_PROPOSAL_BACKOFF_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

function getRun(runId: string): ImprovementRun | undefined {
  return db.select().from(improvementRuns).where(eq(improvementRuns.id, runId)).get();
}

function getRepo(repoId: string) {
  return db.select().from(repos).where(eq(repos.id, repoId)).get();
}

function getCard(cardId: string) {
  return db.select().from(cards).where(eq(cards.id, cardId)).get();
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
  __radulfImprovementStopRequests?: Set<string>;
};

function driverGuard(): Set<string> {
  return (g.__radulfImprovementDrivers ??= new Set());
}

// In-process only: distinguishes an operator-requested stop from the
// deadline simply elapsing, both of which the loop observes the same way
// (deadlineAt <= now). Lost across a restart mid-stop — the run then just
// reports "completed" instead of "stopped", which is a labeling nicety, not
// a correctness issue (decision 5: the timer is a soft gate either way).
function stopRequests(): Set<string> {
  return (g.__radulfImprovementStopRequests ??= new Set());
}

/**
 * Block until `cardId` reaches a terminal status (N2). Resolves on whichever
 * fires first: a `bus` event naming this card whose current DB status is
 * already terminal, or a periodic poll (belt-and-braces — the in-process bus
 * is the primary signal, matching the pattern the SSE stream itself relies
 * on).
 */
export function awaitCardTerminal(cardId: string, pollMs = 2_000): Promise<CardStatus> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (status: CardStatus) => {
      if (settled) return;
      settled = true;
      bus.off("event", onEvent);
      clearInterval(timer);
      resolve(status);
    };
    const check = () => {
      if (settled) return;
      const card = getCard(cardId);
      if (card && isTerminalCardStatus(card.status)) finish(card.status);
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
  if (activeRunForRepo(input.repoId)) {
    throw new ClientError("an improvement run is already active for this repo");
  }
  if (!(await listBranches(repo.path)).includes(input.baseBranch)) {
    throw new ClientError("baseBranch does not exist in the repository");
  }
  if (!Number.isInteger(input.budgetMinutes) || input.budgetMinutes < 1) {
    throw new ClientError("budgetMinutes must be a positive integer");
  }

  const featureBranch = `ralph/improve-${Date.now()}`;
  await git(repo.path, "branch", featureBranch, input.baseBranch);

  const row = db
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

  emitEvent("improvement.started", { payload: { runId: row.id, featureBranch } });
  void driveRun(row.id);
  return row;
}

/** Soft-stop (decision/ruling 5): the deadline moves to now, so the driver
 * stops proposing new work the next time it checks between tasks — a task
 * already in flight finishes untouched. */
export function stopImprovementRun(runId: string): ImprovementRun {
  const run = getRun(runId);
  if (!run) throw new ClientError("improvement run not found", 404);
  if (run.status !== "running") throw new ClientError(`cannot stop a ${run.status} run`);
  stopRequests().add(runId);
  return db
    .update(improvementRuns)
    .set({ deadlineAt: now(), updatedAt: now() })
    .where(eq(improvementRuns.id, runId))
    .returning()
    .get();
}

/** Restart drivers for every run still `running` after a boot (N3). Call
 * after `getOrchestrator()` so `recover()` has already flipped any orphaned
 * card to `needs_attention`. Fire-and-forget — a run's driver can legitimately
 * outlive the whole time budget, so this must never block startup. */
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
  stopRequests().delete(runId);
  emitEvent("improvement.completed", {
    payload: {
      runId,
      featureBranch: run.featureBranch,
      tasksSucceeded: run.tasksSucceeded,
      status,
      reason,
    },
  });
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

/** Guarded singleton entry point (N3): a run is driven at most once per
 * process. Never throws — an unexpected failure lands the run in `failed`
 * rather than an unhandled rejection, so callers can always fire-and-forget. */
export async function driveRun(runId: string): Promise<void> {
  const drivers = driverGuard();
  if (drivers.has(runId)) return;
  drivers.add(runId);
  try {
    await runDriverLoop(runId);
  } finally {
    drivers.delete(runId);
  }
}

async function runDriverLoop(runId: string): Promise<void> {
  let emptyStreak = 0;
  try {
    for (;;) {
      const run = getRun(runId);
      if (!run || run.status !== "running") return;

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
        finishRun(runId, stopRequests().has(runId) ? "stopped" : "completed", "deadline reached");
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
          s: settings,
        });
      } catch {
        proposal = null;
      }

      if (!proposal) {
        emptyStreak += 1;
        if (emptyStreak >= EMPTY_PROPOSAL_LIMIT) {
          finishRun(
            runId,
            stopRequests().has(runId) ? "stopped" : "completed",
            "proposer ran dry",
          );
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
        finishRun(runId, stopRequests().has(runId) ? "stopped" : "completed", "deadline reached");
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
    finishRun(runId, "failed", `improvement run crashed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
