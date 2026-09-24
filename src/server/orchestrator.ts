import fs from "node:fs";
import path from "node:path";
import { and, asc, desc, eq, inArray, lt, max } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  db,
  now,
  cards,
  plans,
  runs,
  iterations,
  events,
  repos,
  improvementRuns,
  reviewDeliveries,
  refWrites,
  type ApprovedInstallScript,
  type CardStatus,
  type EpicRunMode,
} from "@/db";
import { emitEvent } from "./events";
import { getSettings, type Settings } from "./settings";
import {
  DONE_FILE_NAMES,
  buildLoopPrompt,
  buildProgressState,
  captureIterationState,
  doneFilePath,
  performIterationBookkeeping,
  performDoneBookkeeping,
  planStatePath,
  ralphDirPath,
  readFileIfExists,
  readPlanState,
  removeRalphFiles,
} from "./bookkeeping";
import { appendTask, firstUnchecked, parseChecklist } from "./checklist";
import { SLOW_ITERATION_MS } from "./analytics";
import { TELEMETRY_KEYS, runTelemetry, type RunTelemetry } from "./harness";
import { listProviderModels, normalizeProvider, preflightProvider, type ProviderId } from "./providers";
import { classifyProviderError, recordProviderOutcome } from "./circuitBreaker";
import { diagnosisMessage, misconfiguredStage } from "./stageDiagnosis";
import { alertWebhookConfigured, postAlert } from "./alerts";
import { repairTaskText, runAcceptanceProbe } from "./acceptanceProbe";
import { recordProviderFailure } from "./providerRateLimit";
import { offRunBranchReason, recordWorktree, removeWorktree, tryGit } from "./git";
import { removeRunTranscripts, runTranscriptDir } from "./retention";
import { getCard, requireCard, type Card } from "./cards";
import { getRepo, requireRepo, type Repo } from "./repos";
import { groupBy } from "./queryGrouping";
import { PlanningService, pendingReplanFeedback, planningDestination, writePlanRow } from "./planningService";
import { EvaluationService, clearEvaluationArtifact } from "./evaluationService";
import { ReviewService, type ConfigApproval } from "./reviewService";
import { releaseStaleLeases } from "./repoLeases";
import { ClientError } from "./clientError";
import { hasRole } from "./roles";
import {
  HEARTBEAT_INTERVAL_MS,
  deleteWorker,
  heartbeatWorker,
  liveWorkerIds,
  registerWorker,
  staleBefore,
  staleWorkerIds,
} from "./workers";
import { CHECKLIST_EXHAUSTED_EXIT, LOOP_BLOCKED_EXIT, retryableFailedStep } from "@/shared/failedStep";
import { scriptKey } from "@/shared/installScripts";
import { parsePayload } from "@/shared/eventPayload";
import { RUNNING_STATUSES, SCOPABLE_STATUSES } from "@/shared/cardStatus";
import { errorMessage } from "@/shared/errorMessage";
import { addScopingMessage, proposeScopedPlan, proposeSplit } from "./scoping";
import {
  FINISHED_STATUSES,
  epicFinished,
  hasChildren,
  heldByEpicOrder,
  listChildren,
  type BreakdownPiece,
} from "./epics";
import { createRunSandbox, runScratchRoot } from "./sandbox/context";
import { ensureBallast, startDiskWatchdog } from "./sandbox/diskWatchdog";
import {
  removeBaseline,
  saveBaseline,
  snapshotRepoIntegrity,
} from "./integrity";
import {
  collectLifecycleScripts,
  lockfileFingerprint,
  rebuildPackages,
  sandboxedNpmRunner,
  unapprovedScripts,
} from "./installGate";
import {
  circuitOpenReason,
  integrityViolationReason,
  resolveWorktree,
  runWithTranscript,
  sandboxUnavailableReason,
  type FinishStatus,
  type StageDependencies,
} from "./stage";

type Run = typeof runs.$inferSelect;
type Plan = typeof plans.$inferSelect;

/** Everything a claimed loop run needs, read once inside `claimLoopRun`. */
export type LoopClaim = {
  runId: string;
  card: Card;
  repo: Repo;
  plan: Plan;
  settings: Settings;
  prev: Run | undefined;
  provider: ProviderId;
  loopModel: string;
};

/** How often to look for a card that has been waiting on a human (spec 18 §5).
 * Well under the smallest useful staleness setting — the setting decides when
 * to speak, this only decides how often to look. */
const ATTENTION_SWEEP_MS = 60_000;

/** Spec 25 decision 4: how often a worker checks `runs.control` for the runs
 * whose harness it holds. Floored so a bad env value cannot hammer SQLite. */
const CONTROL_POLL_INTERVAL_MS = Math.max(100, Number(process.env.RADULF_CONTROL_POLL_INTERVAL_MS) || 1_000);

/** How many productive iterations a run must have before its own pace, rather
 * than the configured ceiling, bounds a single iteration. */
const BUDGET_MIN_SAMPLES = 3;
/** Never cap an iteration below this, however fast the run has been. */
const BUDGET_FLOOR_MS = 10 * 60 * 1000;
/** How much slower than its run's median a productive iteration may be. */
const BUDGET_MULTIPLIER = 3;

/**
 * The time budget for one iteration.
 *
 * Until a run has shown what a productive iteration costs it, the configured
 * ceiling stands. After that, an iteration is capped at a multiple of the
 * median of the iterations that actually advanced the checklist. A small model
 * that thrashes otherwise spends the entire ceiling on one task: measured on a
 * real run, a loop burned 51 of its 60 allotted minutes on a task whose
 * siblings averaged under two, and produced nothing. Never below the floor,
 * never above the ceiling.
 */
export function iterationBudgetMs(ceilingMs: number, productiveMs: number[]): number {
  if (productiveMs.length < BUDGET_MIN_SAMPLES) return ceilingMs;
  const sorted = [...productiveMs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return Math.min(ceilingMs, Math.max(BUDGET_FLOOR_MS, BUDGET_MULTIPLIER * median));
}

/** How many earlier iterations a run needs before their prompt sizes say
 * anything about what is normal for it. */
const BLOAT_MIN_SAMPLES = 3;
/** How many times the run's median prompt an iteration may reach before it is
 * worth saying so. Chosen against a real run: 4 flags the 846k-token
 * iteration that went on to hit the hard timeout (11.6x its run's median) and
 * the 6.0M-token one that burned an hour (5.3x), and flags no iteration twice
 * in a row that went on to finish its task. */
const BLOAT_MULTIPLIER = 4;

/**
 * How far out of scale this iteration's prompt is with the run's own, or null
 * while the run has too little history to say (spec 18 §9).
 *
 * Tokens rather than cost because every provider reports them. The card this
 * was measured against ran entirely on a local model, where `costUsd` is 0 for
 * every run, so the one budget signal Radulf had was blind on the provider
 * actually in use.
 */
export function promptBloatRatio(
  promptTokens: number | null | undefined,
  earlier: number[],
): number | null {
  if (!promptTokens || earlier.length < BLOAT_MIN_SAMPLES) return null;
  const sorted = [...earlier].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return median > 0 ? promptTokens / median : null;
}

/**
 * When an iteration is worth calling slow: half its own budget, floored at the
 * flat threshold (spec 18 §10).
 *
 * A fixed five minutes fired on 11 of one card's 19 iterations and on 5 of 5
 * in its last run, which is not a signal. Half the budget says "this iteration
 * has spent half its allowance", which means the same thing whatever the
 * allowance is. The floor keeps the default ceiling's behaviour exactly as it
 * was, and SLOW_ITERATION_MS stays the comparison point for the cross-run KPIs
 * in analytics.ts, which have no single run's budget to scale to.
 */
export function slowIterationMs(budgetMs: number): number {
  return Math.max(SLOW_ITERATION_MS, Math.round(budgetMs / 2));
}

/** Appended to the next prompt for an agent that did the work and never wrote
 * the signal file. Without the file the orchestrator cannot tick or commit, so
 * the same task comes back around; saying nothing invites the same ending. */
const SIGNAL_REMINDER = `

IMPORTANT: your previous attempt at this task ended without writing \`.ralph/ITERATION_DONE\`. Nothing it did was recorded or committed, and that is why you are being handed the same task again. Whatever else you do this iteration, finish by writing a one or two line summary of your work into \`.ralph/ITERATION_DONE\`.
`;

/** Record on the iteration row whether its injected task is now ticked off —
 * read from the checklist itself, so every bookkeeping path agrees. */
function recordTaskCompleted(iterationId: number, planPath: string, taskNumber: number) {
  const item = parseChecklist(
    fs.readFileSync(/* turbopackIgnore: true */ planPath, "utf8"),
  )?.items[taskNumber - 1];
  db.update(iterations)
    .set({ taskCompleted: item?.checked ? 1 : 0 })
    .where(eq(iterations.id, iterationId))
    .run();
}

function approvedScripts(repo: typeof repos.$inferSelect): ApprovedInstallScript[] {
  try {
    return JSON.parse(repo.approvedInstallScripts) as ApprovedInstallScript[];
  } catch {
    return []; // Corrupt store — treat as nothing approved (the safe direction).
  }
}

/** Build planning candidates from the Todo queue. Explicit manual starts are
 * oldest-first by ISO timestamp, independent of their queue position. */
export function planningCandidates(
  todoCards: { id: string; repoId: string; startedAt: string | null }[],
  autoMode: boolean,
): { cardId: string; repoId: string }[] {
  const queued = todoCards
    .filter((card) => card.startedAt !== null)
    .sort((a, b) => a.startedAt!.localeCompare(b.startedAt!));
  const eligible = autoMode
    ? [...queued, ...todoCards.filter((card) => card.startedAt === null)]
    : queued;
  return eligible.map((card) => ({ cardId: card.id, repoId: card.repoId }));
}

/**
 * Spec 25 (decisions 2 and 3): the orchestrator keeps NO in-memory record of
 * which cards are starting, paused or awaiting evaluation, because two worker
 * processes may share one SQLite database and each would only see its own
 * memory. The former in-memory bookkeeping was replaced as follows:
 *
 * - the former in-memory set of cards being started →
 *   `claimLoopRun()`: a `BEGIN IMMEDIATE` transaction that moves the card
 *   ready → looping and inserts the running `runs` row (stamped with
 *   `runs.worker_id`) in one step, checking the per-repo cap from the DB only.
 * - the former in-memory pending-evaluation map →
 *   `cards.evaluation_pending`; `pump()` reads flagged cards and claims each
 *   through `claimPendingEvaluation()` under `BEGIN IMMEDIATE`.
 * - the former in-memory pause set → the card status `paused`
 *   itself: `pauseCard()` moves looping → paused immediately and `runLoop()`
 *   closes the run when it observes that status.
 *
 * Cross-process liveness comes from the `workers` table (heartbeats) and
 * `reapStaleRuns()`, which interrupts runs owned by dead workers.
 */

/** Every Orchestrator whose timers are still live; see disposeAllOrchestrators(). */
const liveOrchestrators = new Set<Orchestrator>();

/**
 * Stop the heartbeat/reaper and attention-sweep timers of every live
 * Orchestrator. For test suites (so a finished file leaves no 5-second
 * interval running against the shared DB) and final process exit.
 */
export function disposeAllOrchestrators(): void {
  for (const orchestrator of liveOrchestrators) orchestrator.dispose();
}

export class Orchestrator {
  /** Set on graceful shutdown: pump() starts no new runs, and a running loop
   * stops at its next iteration boundary. */
  private draining = false;
  /** runId → controller for every live harness invocation. */
  private controllers = new Map<string, AbortController>();

  private stageDeps: StageDependencies = {
    getCard,
    workerId: () => this.workerId,
    latestPlan: (cardId) => this.latestPlan(cardId),
    latestWorktreeRun: (cardId) => this.latestWorktreeRun(cardId),
    moveCard: (cardId, from, to, reason) => this.moveCard(cardId, from, to, reason),
    finishRun: (runId, status, exitReason, telemetry) =>
      this.finishRun(runId, status, exitReason, telemetry),
    registerController: (runId, controller) => this.controllers.set(runId, controller),
    releaseController: (runId) => this.controllers.delete(runId),
  };
  private planningService = new PlanningService({ ...this.stageDeps, pump: () => this.pump() });
  private evaluationService = new EvaluationService({
    ...this.stageDeps,
    // Spec 20: the evaluator was the one stage that never pumped, so the slot
    // it freed stayed empty until some unrelated event advanced the queue. A
    // repo with cards waiting could sit idle indefinitely; with a cap above 1
    // it would leave several slots empty at once.
    pump: () => this.pump(),
    replan: (cardId) => this.startStage("planning", cardId),
    // "auto": the evaluator released this diff, not a human. Spec 15 makes a
    // pull request delivered this way a draft.
    approveReview: (runId) => this.reviewService.approve(runId, "auto"),
  });
  private reviewService = new ReviewService({
    ...this.stageDeps,
    pump: () => this.pump(),
    // Spec 25 decision 6: a closure, not the value — `passive` is assigned in
    // the constructor, after this field initialiser has already run.
    passive: () => this.passive,
  });

  /** Spec 18 §5 sweep timer, held so startDraining() can stop it. */
  private attentionTimer: ReturnType<typeof setInterval> | null = null;

  /** Spec 25 decision 4 poll of `runs.control`; see applyControlSignals(). */
  private controlTimer: ReturnType<typeof setInterval> | null = null;

  /** A passive orchestrator is what a process with only the `web` role gets
   * (spec 25). It moves cards for operator actions but never runs boot
   * recovery, never pumps the queue, never starts a stage and never
   * constructs a pi session; a worker process picks the work up from the
   * database. Two processes both recovering or pumping would otherwise race
   * over the same runs. */
  private readonly passive: boolean;

  /** This process's row in the `workers` table (spec 25). Every run this
   * orchestrator starts is stamped with it so a peer can tell whose claim a
   * running row is, and whether its owner is still heartbeating. */
  readonly workerId: string;
  /** Roles this process registered with; re-sent on every heartbeat so the
   * worker can re-register itself if a peer's reaper deleted its row. */
  private readonly roles: string[];
  /** Refreshes workers.heartbeatAt. Deliberately NOT cleared by
   * startDraining(): a draining worker is still finishing its last iteration
   * and must keep heartbeating so no peer reaps that run as orphaned. */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: { autoStart?: boolean; passive?: boolean } = {}) {
    this.passive = options.passive === true;
    this.roles = this.passive ? ["web"] : ["worker"];
    this.workerId = registerWorker(this.roles);
    this.heartbeatTimer = setInterval(() => {
      try {
        heartbeatWorker(this.workerId, this.roles);
        if (!this.passive) {
          try {
            this.reapStaleRuns();
          } catch (e) {
            console.error("[radulf] stale reaper failed:", e);
          }
        }
      } catch (e) {
        console.error("[radulf] heartbeat failed:", e);
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
    if (!this.passive) {
      // Guarded like the other timers: a throw here would be an uncaught
      // exception and take the worker down.
      this.controlTimer = setInterval(() => {
        try {
          this.applyControlSignals();
        } catch (e) {
          console.error("[radulf] control poll failed:", e);
        }
      }, CONTROL_POLL_INTERVAL_MS);
      this.controlTimer.unref?.();
    }
    if (options.autoStart !== false && !this.passive) {
      this.recover();
      this.pump();
      // Guarded: a throw from a timer callback is an uncaught exception, and
      // nothing above this registers a handler for those, so a busy SQLite
      // (a VACUUM INTO backup holding the lock past the 5s busy timeout, say)
      // would take the whole server down once a minute instead of once.
      this.attentionTimer = setInterval(() => {
        try {
          this.sweepStaleAttention();
        } catch (e) {
          console.error("[radulf] attention sweep failed:", e);
        }
      }, ATTENTION_SWEEP_MS);
      // Never hold the process open for a sweep (same reasoning as the disk
      // watchdog): this is a reminder, not work.
      this.attentionTimer.unref?.();
    }
    liveOrchestrators.add(this);
  }

  /**
   * Stop this orchestrator's timers for good. Intended for tests and for
   * final process exit only. Note that `startDraining()` deliberately does
   * NOT stop the heartbeat: a draining worker is still finishing its last
   * iteration and must keep its claim alive so no peer reaps that run.
   */
  dispose(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.attentionTimer) clearInterval(this.attentionTimer);
    this.attentionTimer = null;
    if (this.controlTimer) clearInterval(this.controlTimer);
    this.controlTimer = null;
    liveOrchestrators.delete(this);
  }

  /**
   * Spec 25 decision 4: honour `runs.control` for the runs whose harness this
   * process holds. A web-only process that cancels a card finishes the run
   * row and writes `control = 'cancel'`; it has no AbortController for the
   * harness, so the owning worker fires its own here. The signal is consumed
   * (column cleared) once the abort has fired. Nothing else is written: the
   * run row was already finished by the process that issued the verb, and the
   * existing `!active()` guards and the `finally` in runLoop do the transcript
   * ending, telemetry and cleanup exactly as an in-process cancel does. A
   * `pause` is left alone — the loop observes it at its iteration boundary.
   *
   * A process running both roles aborts locally in endActiveRun and again
   * here, harmlessly: AbortController.abort() is idempotent.
   */
  applyControlSignals(): void {
    if (this.controllers.size === 0) return;
    const rows = db
      .select({ id: runs.id, control: runs.control })
      .from(runs)
      .where(inArray(runs.id, [...this.controllers.keys()]))
      .all();
    for (const row of rows) {
      if (row.control !== "cancel") continue;
      this.controllers.get(row.id)?.abort();
      db.update(runs)
        .set({ control: null })
        .where(and(eq(runs.id, row.id), eq(runs.control, "cancel")))
        .run();
    }
  }

  /**
   * Announce a card that has been waiting on a human too long (spec 18 §5).
   *
   * Once per entry into Needs Attention, never a repeat: the check is whether
   * a `card.attention_stale` event exists newer than the `card.moved` that put
   * it there. That anchor is used rather than `cards.updatedAt` because
   * editing the card's description or its model overrides — the two things an
   * operator is most likely to do while it waits — would otherwise restart the
   * clock on the very card being waited on.
   */
  sweepStaleAttention() {
    const staleBefore = new Date(Date.now() - getSettings().attentionStaleMinutes * 60_000)
      .toISOString();
    const waiting = db
      .select()
      .from(cards)
      .where(eq(cards.status, "needs_attention"))
      .all();
    if (waiting.length === 0) return;
    // Only the two event types the decision turns on, for every waiting card
    // in one query — not each card's whole history.
    const markerEvents = groupBy(
      db
        .select()
        .from(events)
        .where(
          and(
            inArray(events.cardId, waiting.map((card) => card.id)),
            inArray(events.type, ["card.attention_stale", "card.moved"]),
          ),
        )
        .orderBy(desc(events.id))
        .all(),
      (e) => e.cardId!,
    );
    for (const card of waiting) {
      // Walking back by event id rather than by timestamp: the newest of
      // these two decides. An announcement first means this entry has already
      // been announced; the move first means it has not.
      const marker = markerEvents.get(card.id)?.find(
        (e) =>
          e.type === "card.attention_stale" ||
          (e.type === "card.moved" && parsePayload(e.payload).to === "needs_attention"),
      );
      if (!marker || marker.type !== "card.moved") continue;
      const enteredAt = marker.createdAt;
      if (enteredAt > staleBefore) continue;

      const reason = String(parsePayload(marker.payload).reason ?? "");
      const waitingMinutes = Math.round((Date.now() - Date.parse(enteredAt)) / 60_000);
      emitEvent("card.attention_stale", {
        cardId: card.id,
        payload: { waitingMinutes, enteredAt, reason },
      });
      void postAlert({
        type: "card.attention_stale",
        cardId: card.id,
        title: `${card.title} has been waiting ${waitingMinutes} minutes`,
        message: reason || "The card needs a decision before the pipeline can continue.",
        url: `/card/${card.id}`,
      });
    }
  }

  // ---- boot recovery -------------------------------------------------------

  private recover() {
    // Boot recovery is just the first pass of the continuous stale reaper: any
    // running run whose owner is not heartbeating (or was never recorded) is
    // marked interrupted and its card parked or resumed. Run-less orphan
    // cards are only swept here, at boot, when nothing of ours is in flight.
    this.reapStaleRuns({ orphans: true });
    // Sweep the per-run scratch root (private TMPDIRs, caches, pgid files) of
    // everything that no longer belongs to a live run. A peer worker's
    // in-flight run keeps its directory: its TMPDIR must survive our boot.
    const root = /* turbopackIgnore: true */ runScratchRoot();
    if (fs.existsSync(root)) {
      const live = liveWorkerIds(getSettings().workerStaleSeconds);
      const liveRunIds = db
        .select({ id: runs.id, workerId: runs.workerId })
        .from(runs)
        .where(eq(runs.status, "running"))
        .all()
        .filter((r) => r.workerId !== null && live.has(r.workerId))
        .map((r) => r.id);
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.name === "ballast") continue;
        if (liveRunIds.some((id) => entry.name.startsWith(id))) continue;
        fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
      }
    }
  }

  /** Continuous stale reaper. Every `running` run whose owning worker has
   * stopped heartbeating (or that has no owner at all — a row from before
   * workers existed, or a process that died between insert and claim) is
   * marked interrupted and its card either resumed (a checkpointed loop) or
   * parked in Needs Attention, and dead worker rows are deleted. Safe to run
   * from any worker at any time: the run update is a CAS on
   * `status = running`, so two reapers racing over the same run only let one
   * of them through.
   *
   * With `options.orphans` set, cards stuck in a running (or `reviewing`)
   * status with no run at all get the same treatment once they have been
   * idle past the stale window. That sweep is boot-only: a run-less card has
   * no ownership row anywhere, so a continuous pass cannot tell an abandoned
   * card from one this or a live peer process is actively working on (a
   * `reviewing` merge in flight, or a `planning`/`evaluating` card still
   * creating its worktree before its run row exists). Only boot, when this
   * process knows it has nothing in flight, may judge it. Spec 25 decision 6
   * gives a review delivery a `review_deliveries` row, so the continuous
   * pass does reason about those: a `running` delivery whose worker has
   * stopped heartbeating is finished as failed, its card parked, and its
   * repo lease released; a `reviewing` card with a pending or running
   * delivery is left alone by the orphan sweep because a worker owns it (or
   * will claim it). */
  reapStaleRuns(options: { orphans?: boolean } = {}): void {
    // Read on every call, never cached: the operator can widen or narrow the
    // window at runtime and the next pass must honour it.
    const staleSeconds = getSettings().workerStaleSeconds;
    const live = liveWorkerIds(staleSeconds);
    // Our own runs are never stale, however far behind our heartbeat row is
    // (a long SQLite stall must not make a worker reap itself).
    live.add(this.workerId);

    const running = db.select().from(runs).where(eq(runs.status, "running")).all();
    for (const run of running) {
      if (run.workerId !== null && live.has(run.workerId)) continue;
      const exitReason = run.workerId
        ? `worker ${run.workerId} stopped heartbeating`
        : "server restarted mid-run";
      const result = db
        .update(runs)
        .set({ status: "interrupted", exitReason, endedAt: now() })
        .where(and(eq(runs.id, run.id), eq(runs.status, "running")))
        .run();
      if (result.changes !== 1) continue;
      // Only the iterations still open: finished ones keep their verdicts.
      db.update(iterations)
        .set({ status: "failed", summary: "interrupted by worker loss", endedAt: now() })
        .where(and(eq(iterations.runId, run.id), eq(iterations.status, "running")))
        .run();
      emitEvent("run.finished", {
        cardId: run.cardId,
        runId: run.id,
        payload: { status: "interrupted", exitReason },
      });
      const card = getCard(run.cardId);
      if (card) this.parkOrResume(card);
    }

    // Spec 25 decision 6: a delivery whose claiming worker died mid-merge.
    // Same CAS shape as the run update, so two reapers cannot both park the
    // card. The pending rows are left alone: any live worker's pump claims
    // them.
    const runningDeliveries = db
      .select()
      .from(reviewDeliveries)
      .where(eq(reviewDeliveries.status, "running"))
      .all();
    for (const delivery of runningDeliveries) {
      if (delivery.workerId !== null && live.has(delivery.workerId)) continue;
      const error = `worker ${delivery.workerId} stopped heartbeating during delivery`;
      const result = db
        .update(reviewDeliveries)
        .set({ status: "finished", ok: 0, error, endedAt: now() })
        .where(and(eq(reviewDeliveries.id, delivery.id), eq(reviewDeliveries.status, "running")))
        .run();
      if (result.changes !== 1) continue;
      this.moveCard(delivery.cardId, "reviewing", "needs_attention", error);
      emitEvent("review.decided", {
        cardId: delivery.cardId,
        runId: delivery.runId,
        payload: { decision: "approved", deliveryFailed: error },
      });
    }
    releaseStaleLeases(live);
    // The ref audit log only has to outlive the integrity checks that consult
    // it; a week is far past any run's lifetime.
    db.delete(refWrites)
      .where(lt(refWrites.writtenAt, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()))
      .run();

    if (options.orphans) {
      // Any card still marked planning/looping/evaluating with no run at all
      // lost its run some other way (a reviewing card whose delivery row was
      // finished — or never created — without the card being moved on). Only
      // cards idle past the stale window count: a card
      // that just moved into a running status may be about to get its run
      // inserted. Boot-only, see the JSDoc above.
      const orphans = db
        .select()
        .from(cards)
        .where(
          and(
            inArray(cards.status, [...RUNNING_STATUSES, "reviewing"]),
            lt(cards.updatedAt, staleBefore(staleSeconds)),
          ),
        )
        .all();
      for (const card of orphans) {
        const active = db
          .select({ id: runs.id })
          .from(runs)
          .where(and(eq(runs.cardId, card.id), eq(runs.status, "running")))
          .get();
        if (active) continue;
        // A reviewing card with a queued or running delivery is owned (or
        // about to be claimed) by a worker; the delivery reaper above judges
        // it, not this sweep.
        if (card.status === "reviewing") {
          const owned = db
            .select({ id: reviewDeliveries.id })
            .from(reviewDeliveries)
            .where(
              and(
                eq(reviewDeliveries.cardId, card.id),
                inArray(reviewDeliveries.status, ["pending", "running"]),
              ),
            )
            .get();
          if (owned) continue;
        }
        this.parkOrResume(card);
      }
    }

    for (const id of staleWorkerIds(staleSeconds)) {
      if (id !== this.workerId) deleteWorker(id);
    }
  }

  /** A loop is checkpointed: the orchestrator commits every finished
   * iteration and ticks the private plan checklist, so losing its worker
   * costs at most the one iteration that was in flight. Put a resumable card
   * back in Ready and let pump() open a fresh loop run on the first unchecked
   * task, instead of making a human press Retry to lose nothing. Every other
   * stage re-runs from the top, so those still need a human. */
  private parkOrResume(card: Card) {
    if (card.status === "looping" && this.loopIsResumable(card.id)) {
      this.moveCard(card.id, "looping", "ready", "resuming after worker loss");
      return;
    }
    if (RUNNING_STATUSES.includes(card.status) || card.status === "reviewing") {
      this.moveCard(card.id, card.status, "needs_attention", "interrupted");
    }
  }

  /** Whether a restarted loop can pick up where it left off: the plan it was
   * executing is still on disk with an unchecked task left in it, and the
   * worktree holding the committed iterations still exists. A plan with every
   * task ticked is finishing, not resuming, so it goes to a human too. */
  private loopIsResumable(cardId: string): boolean {
    if (!this.latestPlan(cardId)) return false;
    const planMd = readPlanState(cardId);
    if (!planMd || !firstUnchecked(planMd)) return false;
    const worktreePath = this.latestWorktreeRun(cardId)?.worktreePath;
    return worktreePath !== undefined && fs.existsSync(/* turbopackIgnore: true */ worktreePath);
  }

  // ---- helpers -------------------------------------------------------------

  private moveCard(cardId: string, from: CardStatus, to: CardStatus, reason?: string): boolean {
    // Leaving Needs Attention by any route (human or otherwise) clears the
    // queued-evaluation flag (spec 25): pump() must not later pull the card
    // into evaluating after someone restarted, retried, or cancelled it.
    const result = db
      .update(cards)
      .set({ status: to, updatedAt: now(), ...(from === "needs_attention" ? { evaluationPending: 0 } : {}) })
      .where(and(eq(cards.id, cardId), eq(cards.status, from)))
      .run();
    if (result.changes !== 1) return false;
    emitEvent("card.moved", { cardId, payload: { from, to, ...(reason ? { reason } : {}) } });
    this.alertOnArrival(cardId, to, reason);
    if (FINISHED_STATUSES.includes(to)) this.completeEpicIfFinished(cardId);
    return true;
  }

  /**
   * Move a card into a stage that consumes a pipeline slot (planning or
   * evaluating) under `BEGIN IMMEDIATE`, re-checking both the card's status
   * and the repo's load inside the same transaction. Two workers sharing the
   * database therefore cannot each pass the load check and start two
   * different cards of one repo past its cap. Same shape as
   * claimPendingEvaluation; neither destination is an alert or finished
   * status, so moveCard's follow-ups do not apply here.
   */
  claimStage(cardId: string, from: CardStatus, to: "planning" | "evaluating", reason?: string): boolean {
    const claimed = db.transaction(
      (tx) => {
        const fresh = tx
          .select({ status: cards.status, repoId: cards.repoId })
          .from(cards)
          .where(eq(cards.id, cardId))
          .get();
        if (fresh?.status !== from) return false;
        if (this.loadFor(fresh.repoId, tx) >= this.concurrencyLimit()) return false;
        const moved = tx
          .update(cards)
          .set({ status: to, updatedAt: now(), ...(from === "needs_attention" ? { evaluationPending: 0 } : {}) })
          .where(and(eq(cards.id, cardId), eq(cards.status, from)))
          .run();
        return moved.changes === 1;
      },
      { behavior: "immediate" },
    );
    if (!claimed) return false;
    emitEvent("card.moved", { cardId, payload: { from, to, ...(reason ? { reason } : {}) } });
    return true;
  }

  /** Spec 24 decision 6: the last piece finishing finishes its epic. */
  private completeEpicIfFinished(childId: string) {
    const parentId = getCard(childId)?.parentCardId;
    if (!parentId) return;
    const children = listChildren(parentId);
    if (!epicFinished(children)) return;
    if (this.moveCard(parentId, "backlog", "done", "every task in the epic finished")) {
      emitEvent("epic.completed", { cardId: parentId, payload: { cardIds: children.map((c) => c.id) } });
    }
  }

  /**
   * Announce a card the moment it reaches a gate that waits on a human.
   *
   * `sweepStaleAttention` only speaks up once a card has already been ignored
   * for `attentionStaleMinutes`, and it only watches Needs Attention — a diff
   * cleared into In Review is the thing an operator is most likely to be
   * waiting for, and it had no way off this machine at all. Every transition
   * routes through `moveCard`, including the ones `evaluationService` and
   * `reviewService` drive through `deps`, so this is the one place that sees
   * them all.
   */
  private alertOnArrival(cardId: string, to: CardStatus, reason?: string) {
    if (to !== "review" && to !== "needs_attention") return;
    const settings = getSettings();
    if (!alertWebhookConfigured()) return;
    if (!(to === "review" ? settings.alertOnReviewReady : settings.alertOnNeedsAttention)) return;
    const card = db.select().from(cards).where(eq(cards.id, cardId)).get();
    if (!card) return;
    void postAlert(
      to === "review"
        ? {
            type: "card.review_ready",
            cardId,
            title: `${card.title} is ready for review`,
            message: reason || "The evaluator cleared the diff.",
            url: `/review/${cardId}`,
          }
        : {
            type: "card.needs_attention",
            cardId,
            title: `${card.title} needs your attention`,
            message: reason || "The card needs a decision before the pipeline can continue.",
            url: `/card/${cardId}`,
          },
    );
  }

  private failIterations(runId: string, summary: string) {
    db.update(iterations)
      .set({ status: "failed", summary, endedAt: now() })
      .where(eq(iterations.runId, runId))
      .run();
  }

  /** Run the planner or evaluator in the background on a card already moved
   * into that stage; a crash lands the card in needs_attention. */
  private startStage(stage: "planning" | "evaluating", cardId: string) {
    const run =
      stage === "planning"
        ? this.planningService.runPlanning(cardId)
        : this.evaluationService.runEvaluator(cardId);
    void run.catch((err) => {
      if (getCard(cardId)?.status === stage) {
        this.moveCard(cardId, stage, "needs_attention", String(err));
      }
    });
  }

  /** Mark a run finished — only if it is still `running` (guards cancel races).
   * The status flip is a compare-and-set on `status = 'running'`: when a peer
   * process already ended the run, its cause wins and this call returns false
   * without emitting a second `run.finished` (spec 25 decision 4: the first
   * terminal cause wins across processes). */
  private finishRun(
    runId: string,
    status: FinishStatus,
    exitReason: string,
    telemetry?: RunTelemetry,
  ): boolean {
    const run = db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!run || run.status !== "running") return false;
    // Plan/evaluate pass their single invocation's telemetry; a loop run's
    // lives per iteration, so roll it up from the iterations just recorded.
    const rollup = telemetry ?? (run.kind === "loop" ? this.loopTelemetryRollup(runId) : undefined);
    // Spec 18 §3: classify the ending once, here, rather than leaving every
    // reader to re-parse the message to work out whether a retry could help.
    // Only a failure can carry a kind — a completed run's reason is a verdict,
    // not an error.
    const failureKind = status === "completed" || status === "paused"
      ? null
      : classifyProviderError(exitReason);
    const result = db.update(runs)
      .set({
        status,
        exitReason,
        failureKind,
        endedAt: now(),
        ...(rollup ?? {}),
      })
      .where(and(eq(runs.id, runId), eq(runs.status, "running")))
      .run();
    if (result.changes !== 1) return false;
    emitEvent("run.finished", { cardId: run.cardId, runId, payload: { status, exitReason } });
    // Spec 18 §4: judge the sequence, not just this attempt. Emitted from
    // here because every stage ends through finishRun, so there is one place
    // that sees the streak rather than one per failure path.
    const diagnosis = misconfiguredStage(
      db.select().from(runs).where(eq(runs.cardId, run.cardId)).all(),
      run.kind,
    );
    if (diagnosis) {
      emitEvent("stage.misconfigured", {
        cardId: run.cardId,
        runId,
        payload: { ...diagnosis, message: diagnosisMessage(diagnosis) },
      });
    }
    return true;
  }

  /** Sum a loop run's iterations. A field is null only when NO iteration
   * reported it, so a partial sample still sums the facts it has. Time to
   * first token and harness identity describe the run's start — the first
   * iteration's value. */
  private loopTelemetryRollup(runId: string): RunTelemetry {
    const rows = db
      .select()
      .from(iterations)
      .where(eq(iterations.runId, runId))
      .orderBy(asc(iterations.n))
      .all();
    const firstOnly = new Set<keyof RunTelemetry>(["firstTokenMs", "harness", "harnessVersion"]);
    const rollup = {} as Record<keyof RunTelemetry, unknown>;
    for (const key of TELEMETRY_KEYS) {
      if (firstOnly.has(key)) {
        rollup[key] = rows[0]?.[key] ?? null;
        continue;
      }
      const present = rows.map((r) => r[key] as number | null).filter((v): v is number => v != null);
      rollup[key] = present.length > 0 ? present.reduce((s, v) => s + v, 0) : null;
    }
    return rollup as RunTelemetry;
  }

  /** External awaits may finish after a user cancellation. Never let their
   * continuation mutate a run/card that is no longer the live loop. */
  private isRunActive(runId: string, cardId: string, signal: AbortSignal): boolean {
    if (signal.aborted) return false;
    const run = db.select().from(runs).where(eq(runs.id, runId)).get();
    if (run?.status !== "running") return false;
    // Spec 25 decision 4: a pause moves the card at once, but its loop is
    // still live until the iteration boundary and must bank that iteration.
    const status = getCard(cardId)?.status;
    return status === "looping" || status === "paused";
  }

  private latestPlan(cardId: string) {
    return db
      .select()
      .from(plans)
      .where(eq(plans.cardId, cardId))
      .orderBy(desc(plans.version))
      .limit(1)
      .get();
  }

  /** Most recent run whose worktree still exists on disk. */
  latestWorktreeRun(cardId: string): Run | undefined {
    const rows = db
      .select()
      .from(runs)
      .where(eq(runs.cardId, cardId))
      .orderBy(desc(runs.startedAt))
      .all();
    return rows.find((r) => fs.existsSync(/* turbopackIgnore: true */ r.worktreePath));
  }

  /** Finish the card's live run, if any, fail its open iterations, and abort
   * its harness. */
  private endActiveRun(cardId: string, status: FinishStatus, reason: string) {
    const active = db
      .select()
      .from(runs)
      .where(and(eq(runs.cardId, cardId), eq(runs.status, "running")))
      .orderBy(desc(runs.startedAt))
      .limit(1)
      .get();
    if (!active) return;
    // When a peer process (or the worker itself) finalized this run first, the
    // first terminal cause wins: leave the iteration rows and `runs.control`
    // alone rather than overwriting the winner's bookkeeping.
    if (!this.finishRun(active.id, status, reason)) return;
    this.failIterations(active.id, reason);
    // Spec 25 decision 4: the owning worker (possibly another process) polls
    // this column and aborts its local controller. The local abort below
    // still runs so a single-process deployment stays exactly as fast.
    db.update(runs).set({ control: "cancel" }).where(eq(runs.id, active.id)).run();
    this.controllers.get(active.id)?.abort();
  }

  // ---- entry points --------------------------------------------------------

  /** Todo → In Progress. Plans if needed, otherwise queues for the loop slot. */
  startCard(cardId: string) {
    const card = requireCard(cardId);
    if (!["todo", "needs_attention"].includes(card.status))
      throw new ClientError(`cannot start card in status ${card.status}`);
    if (hasChildren(cardId)) throw new ClientError("an epic does not run itself: start its tasks instead");
    if (!card.startedAt)
      db.update(cards).set({ startedAt: now() }).where(eq(cards.id, cardId)).run();

    if (this.latestPlan(cardId) && !pendingReplanFeedback(cardId)) {
      // Restart path — plan exists, go straight to the loop queue. Unplanned
      // feedback (a rejection or an evaluator revise) re-plans first.
      this.moveCard(cardId, card.status, "ready");
      this.pump();
    } else if (this.passive || !this.claimStage(cardId, card.status, "planning")) {
      // One ticket runs at a time (claimStage checks the repo's cap and moves
      // the card to planning atomically). The startedAt set above marks this a manual
      // start; land it back in todo (pump only scans todo for planning) so it
      // is picked up, oldest manual start first, when the pipeline frees. A
      // passive (web-only) process takes the same path unconditionally: it
      // never starts a stage itself, and the worker's pump plans manual
      // starts oldest-first even with autoMode off, so the stamp is enough.
      // (A passive pump() is a no-op, so the restart branch above just moves
      // the card to ready for the worker to pick up.)
      if (card.status !== "todo") {
        this.moveCard(cardId, card.status, "todo", "queued for planning");
      }
    } else {
      this.startStage("planning", cardId);
    }
  }

  /** Backlog → Todo. Auto-mode may immediately claim the queued card. */
  queueCard(cardId: string) {
    const card = requireCard(cardId);
    if (card.status !== "backlog") {
      throw new ClientError(`cannot queue card in status ${card.status}`);
    }
    if (hasChildren(cardId)) throw new ClientError("an epic does not run itself: start its tasks instead");
    // Transaction: two rapid queues must not read the same max position.
    const result = db.transaction((tx) => {
      const maxPosition =
        tx
          .select({ max: max(cards.position) })
          .from(cards)
          .where(eq(cards.status, "todo"))
          .get()?.max ?? 0;
      return tx
        .update(cards)
        .set({ status: "todo", position: maxPosition + 1, startedAt: null, updatedAt: now() })
        .where(and(eq(cards.id, cardId), eq(cards.status, "backlog")))
        .run();
    });
    if (result.changes !== 1) {
      throw new ClientError("card status changed before it could be queued");
    }
    emitEvent("card.moved", { cardId, payload: { from: "backlog", to: "todo", reason: "queued" } });
    this.pump();
  }

  /**
   * Spec 17: let the card's scoping session write the plan and skip the
   * planning stage.
   *
   * No run and no worktree: `startLoop` builds the worktree it needs and
   * installs the plan's artifacts into it from the plan row, so a plan that
   * arrives without a planning run behind it is enough on its own. The card
   * then lands exactly where a planning run would have left it, which is what
   * keeps `reviewPlanBeforeImplementation` meaningful for these cards too.
   */
  async adoptScopingPlan(cardId: string): Promise<{ version: number; status: CardStatus }> {
    const card = requireCard(cardId);
    if (!SCOPABLE_STATUSES.includes(card.status)) {
      throw new ClientError(`cannot write a plan for a card in status ${card.status}`);
    }
    const artifacts = await proposeScopedPlan(cardId);
    if (!firstUnchecked(artifacts.planMd)) {
      throw new ClientError("the plan's checklist is unparseable or has no unchecked tasks");
    }
    const { version } = writePlanRow(cardId, artifacts, { origin: "scoping" });
    const destination = planningDestination(card);
    this.moveCard(cardId, card.status, destination, "plan written while scoping");
    this.pump();
    return { version, status: destination };
  }

  /**
   * Spec 17: ask the session to break the card into ordered pieces. A
   * proposal only — `applyScopingSplit` is the separate, operator-driven step.
   */
  proposeScopingSplit(cardId: string) {
    return proposeSplit(cardId);
  }

  /**
   * Spec 24: break the card down into pieces that become its children. The
   * card stays as the epic: it keeps its thread and its description, leaves
   * the queue for Backlog (an epic's own status is only ever backlog or
   * done), and never runs itself. The pieces are appended to the end of the
   * queue in order, inherit every per-card setting, and may each target
   * another repository, in which case the epic's base branch does not apply.
   * Calling it again on an epic appends more pieces.
   *
   * Refused once the card has a plan: the plan was written for the scope
   * that is now being split, and Reset is the way through. Refused on a card
   * that is itself a piece, because nested epics are out of scope.
   */
  applyBreakdown(cardId: string, pieces: BreakdownPiece[], runMode: EpicRunMode): Card[] {
    const card = requireCard(cardId);
    if (!SCOPABLE_STATUSES.includes(card.status)) {
      throw new ClientError(`cannot break down a card in status ${card.status}`);
    }
    if (card.parentCardId) {
      throw new ClientError("a task that is part of an epic cannot be broken down further");
    }
    if (pieces.length === 0) throw new ClientError("a breakdown needs at least one task");
    if (pieces.some((piece) => !piece.title.trim())) throw new ClientError("every task needs a title");
    if (this.latestPlan(cardId)) {
      throw new ClientError(
        "this card is already planned, so breaking it down now would leave its pieces beside a plan " +
          "for the scope they replace. Reset the card first",
      );
    }
    // Resolved before the transaction so an unknown repository fails the
    // whole request rather than half a breakdown.
    const targets = pieces.map((piece) =>
      piece.repoId && piece.repoId !== card.repoId ? requireRepo(piece.repoId) : null,
    );
    const children = db.transaction((tx) => {
      tx.update(cards)
        .set({ status: "backlog", runMode, startedAt: null, updatedAt: now() })
        .where(eq(cards.id, cardId))
        .run();
      const base =
        (tx.select({ max: max(cards.position) }).from(cards).where(eq(cards.status, "todo")).get()
          ?.max ?? 0) + 1;
      return pieces.map((piece, offset) =>
        tx
          .insert(cards)
          .values({
            id: nanoid(),
            repoId: targets[offset]?.id ?? card.repoId,
            parentCardId: cardId,
            title: piece.title.trim(),
            description: piece.description,
            status: "todo",
            position: base + offset,
            // The epic's base branch belongs to its own repository.
            baseBranch: targets[offset] ? null : card.baseBranch,
            // The pieces inherit every per-card setting, including the
            // scoping flags: the operator chose them for this work, and
            // the work is the same work.
            source: card.source,
            maxIterations: card.maxIterations,
            timeoutMinutes: card.timeoutMinutes,
            reviewPlanBeforeImplementation: card.reviewPlanBeforeImplementation,
            autoApprove: card.autoApprove,
            openPr: card.openPr,
            grillMe: card.grillMe,
            scopingAuthorsPlan: card.scopingAuthorsPlan,
            plannerModel: card.plannerModel,
            loopModel: card.loopModel,
            evaluatorModel: card.evaluatorModel,
            planCritic: card.planCritic,
            criticModel: card.criticModel,
            createdAt: now(),
            updatedAt: now(),
          })
          .returning()
          .get(),
      );
    });
    emitEvent("card.breakdown", {
      cardId,
      payload: { cardIds: children.map((row) => row.id), runMode, from: card.status },
    });
    this.pump();
    return children;
  }

  /**
   * Spec 24 decision 5: queue every piece still in Backlog and mark every
   * queued piece as manually started, then pump. Goes through the queue
   * rather than startCard so an ordered epic still starts one piece at a
   * time, and so it works with Auto Mode off.
   */
  startEpic(cardId: string): { queued: number; started: number } {
    const children = listChildren(cardId);
    if (children.length === 0) throw new ClientError("this card has no tasks to start");
    const queued: string[] = [];
    const started = db.transaction((tx) => {
      let position =
        tx.select({ max: max(cards.position) }).from(cards).where(eq(cards.status, "todo")).get()
          ?.max ?? 0;
      let count = 0;
      for (const child of children) {
        if (child.status === "backlog") {
          position += 1;
          tx.update(cards)
            .set({ status: "todo", position, startedAt: now(), updatedAt: now() })
            .where(eq(cards.id, child.id))
            .run();
          queued.push(child.id);
          count += 1;
        } else if (child.status === "todo") {
          if (!child.startedAt) {
            tx.update(cards).set({ startedAt: now(), updatedAt: now() }).where(eq(cards.id, child.id)).run();
          }
          count += 1;
        }
      }
      return count;
    });
    for (const id of queued) {
      emitEvent("card.moved", { cardId: id, payload: { from: "backlog", to: "todo", reason: "epic started" } });
    }
    this.pump();
    return { queued: queued.length, started };
  }

  /** Spec 24 decision 5: pause every looping piece; each loop stops at its
   * next iteration boundary (spec 25 decision 4: the card moves at once). */
  pauseEpic(cardId: string): { paused: number } {
    const looping = listChildren(cardId).filter((child) => child.status === "looping");
    for (const child of looping) {
      this.moveCard(child.id, "looping", "paused", "pause requested");
      this.requestPause(child.id);
    }
    return { paused: looping.length };
  }

  pauseCard(cardId: string) {
    const card = requireCard(cardId);
    if (card.status !== "looping") throw new ClientError(`cannot pause a ${card.status} card`);
    // Spec 25 decision 4: the pause is an immediate card transition, visible
    // to every worker through the database. The loop stops at its boundary.
    this.moveCard(cardId, "looping", "paused", "pause requested");
    this.requestPause(cardId);
  }

  /** Spec 25 decision 4: tell the worker that owns the card's live run
   * (possibly another process) to stop at its next iteration boundary. */
  private requestPause(cardId: string): void {
    db.update(runs)
      .set({ control: "pause" })
      .where(and(eq(runs.cardId, cardId), eq(runs.status, "running")))
      .run();
  }

  resumeCard(cardId: string) {
    const card = requireCard(cardId);
    if (card.status !== "paused") throw new ClientError(`cannot resume a ${card.status} card`);
    const stillRunning = db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.cardId, cardId), eq(runs.status, "running")))
      .limit(1)
      .get();
    if (stillRunning) {
      throw new ClientError("the loop is still finishing its current iteration — try again in a moment", 409);
    }
    this.moveCard(cardId, "paused", "ready");
    this.pump();
  }

  cancelCard(cardId: string) {
    const card = requireCard(cardId);
    this.endActiveRun(cardId, "cancelled", "cancelled by user");
    // Pulling work back must always land somewhere auto-mode cannot claim.
    // Clear the durable manual-start marker in the same write.
    db.update(cards)
      .set({ status: "backlog", startedAt: null, updatedAt: now() })
      .where(eq(cards.id, cardId))
      .run();
    emitEvent("card.moved", {
      cardId,
      payload: { from: card.status, to: "backlog", reason: "cancelled" },
    });
    this.pump();
  }

  /** Needs Attention → In Progress. */
  restartCard(cardId: string) {
    const card = requireCard(cardId);
    if (card.status !== "needs_attention")
      throw new ClientError(`cannot restart card in status ${card.status}`);
    this.startCard(cardId);
  }

  /** Retry the latest failed pipeline stage without replaying completed ones. */
  retryFailedStep(cardId: string): { ok: true; step: NonNullable<ReturnType<typeof retryableFailedStep>> } {
    const card = requireCard(cardId);
    const step = retryableFailedStep(db.select().from(runs).where(eq(runs.cardId, cardId)).all());
    if (!step) throw new ClientError("the latest pipeline step did not fail");
    if (card.status !== "needs_attention") {
      throw new ClientError(`cannot retry ${step} for card in status ${card.status}`);
    }

    if (step === "loop") {
      if (!this.latestPlan(cardId)) throw new ClientError("card has no plan to retry");
      // A loop that ticked its last task and wrote DONE, then failed on a
      // check after the work (the run-end integrity check, a timeout in the
      // final bookkeeping), has nothing left to inject: another loop run would
      // end on an exhausted checklist within seconds. Evaluation is next, the
      // same resume-in-place rule approveInstallScripts applies.
      const planMd = readPlanState(cardId);
      const worktree = this.latestWorktreeRun(cardId);
      if (planMd && !firstUnchecked(planMd) && worktree && doneFilePath(ralphDirPath(worktree.worktreePath))) {
        if (this.passive) {
          throw new ClientError("this process only serves the UI; a process with the worker role has to run this", 409);
        }
        if (this.pipelineBusy(card.repoId)) throw new ClientError("another task is already being worked on");
        if (!this.moveCard(cardId, "needs_attention", "evaluating", "retrying: loop finished, evaluating")) {
          throw new ClientError("card status changed before the evaluator could start");
        }
        this.startStage("evaluating", cardId);
        return { ok: true, step: "evaluate" };
      }
      if (!this.moveCard(cardId, "needs_attention", "ready", "retrying failed loop")) {
        throw new ClientError("card status changed before the loop could retry");
      }
      this.pump();
      return { ok: true, step };
    }

    if (this.passive) {
      throw new ClientError("this process only serves the UI; a process with the worker role has to run this", 409);
    }
    if (this.pipelineBusy(card.repoId)) throw new ClientError("another task is already being worked on");
    const [stage, agent] = step === "plan"
      ? (["planning", "planner"] as const)
      : (["evaluating", "evaluator"] as const);
    if (!this.claimStage(cardId, "needs_attention", stage, `retrying failed ${agent}`)) {
      throw new ClientError(`card status changed before the ${agent} could retry`);
    }
    this.startStage(stage, cardId);
    return { ok: true, step };
  }

  // ---- pipeline pump -------------------------------------------------------

  /** Stop pump() from starting new runs, and ask a running loop to stop once
   * its current iteration is committed. Called once, on shutdown signal. */
  startDraining() {
    this.draining = true;
    if (this.attentionTimer) clearInterval(this.attentionTimer);
    this.attentionTimer = null;
  }

  /** True while any repo has a run in flight — used by graceful shutdown.
   * Deliberately global, unlike pipelineBusy(repoId). */
  hasInFlightWork(): boolean {
    return this.ownsRunningRun() || this.cardInStatus(RUNNING_STATUSES);
  }

  /** True if a run row claimed by this worker is still `running`. */
  private ownsRunningRun(): boolean {
    return (
      db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.status, "running"), eq(runs.workerId, this.workerId)))
        .limit(1)
        .get() !== undefined
    );
  }

  private cardInStatus(statuses: readonly CardStatus[], repoId?: string): boolean {
    return (
      db
        .select({ id: cards.id })
        .from(cards)
        .where(and(inArray(cards.status, [...statuses]), repoId ? eq(cards.repoId, repoId) : undefined))
        .limit(1)
        .get() !== undefined
    );
  }

  /** How many of `repoId`'s cards are actively running a harness. Queued or
   * human-waiting cards do not count, and repos never share slots.
   *
   * Counted over distinct card ids from the database alone: a card in a
   * running status, or a card with a `running` run row (a loop still tearing
   * down after its card moved on), each hold a slot — whichever worker owns
   * them. */
  private pipelineLoad(repoId: string): number {
    return this.loadFor(repoId);
  }

  /** `pipelineLoad` through `q` — `db` or the transaction handle inside
   * `claimLoopRun`, so the claim counts under `BEGIN IMMEDIATE`. */
  private loadFor(repoId: string, q: Pick<typeof db, "select"> = db): number {
    const running = new Set(
      q
        .select({ id: cards.id })
        .from(cards)
        .where(and(inArray(cards.status, [...RUNNING_STATUSES]), eq(cards.repoId, repoId)))
        .all()
        .map((c) => c.id),
    );
    for (const row of q
      .select({ id: runs.cardId })
      .from(runs)
      .innerJoin(cards, eq(runs.cardId, cards.id))
      .where(and(eq(runs.status, "running"), eq(cards.repoId, repoId)))
      .all()) {
      running.add(row.id);
    }
    return running.size;
  }

  /**
   * Claim the loop run for a Ready card (spec 25 decision 2). Everything the
   * run needs is read up front; the claim itself — card still Ready, no run
   * already `running` for it, a free slot in its repo — is checked and taken
   * inside one `BEGIN IMMEDIATE` transaction, so two workers sharing the
   * database can never both start the same card or overfill a repo. Returns
   * null when the card is not claimable; the card is untouched except for a
   * planless card, which lands in Needs Attention.
   */
  claimLoopRun(cardId: string): LoopClaim | null {
    const card = getCard(cardId);
    if (!card || card.status !== "ready") return null;
    const repo = getRepo(card.repoId);
    if (!repo) return null;
    const plan = this.latestPlan(cardId);
    if (!plan) {
      this.moveCard(cardId, "ready", "needs_attention", "card has no plan");
      return null;
    }
    const settings = getSettings();
    const provider = normalizeProvider(settings.loopProvider, "anthropic");
    const loopModel = card.loopModel || settings.loopModel;
    const prev = this.latestWorktreeRun(cardId);
    const runId = nanoid();
    const limit = this.concurrencyLimit(settings);

    const claimed = db.transaction(
      (tx) => {
        const fresh = tx.select({ status: cards.status }).from(cards).where(eq(cards.id, cardId)).get();
        if (fresh?.status !== "ready") return false;
        const live = tx
          .select({ id: runs.id })
          .from(runs)
          .where(and(eq(runs.cardId, cardId), eq(runs.status, "running")))
          .get();
        if (live) return false;
        if (this.loadFor(card.repoId, tx) >= limit) return false;
        const moved = tx
          .update(cards)
          .set({ status: "looping", updatedAt: now() })
          .where(and(eq(cards.id, cardId), eq(cards.status, "ready")))
          .run();
        if (moved.changes !== 1) return false;
        tx.insert(runs)
          .values({
            id: runId,
            cardId,
            planId: plan.id,
            kind: "loop",
            worktreePath: prev?.worktreePath ?? "",
            branch: prev?.branch ?? "",
            baseBranch: prev?.baseBranch ?? card.baseBranch ?? null,
            provider,
            model: loopModel,
            startedAt: now(),
            sandboxed: settings.sandboxEnabled ? 1 : 0,
            workerId: this.workerId,
          })
          .run();
        return true;
      },
      { behavior: "immediate" },
    );
    if (!claimed) return null;
    emitEvent("card.moved", { cardId, payload: { from: "ready", to: "looping" } });
    return { runId, card, repo, plan, settings, prev, provider, loopModel };
  }

  /**
   * Cards this repo may run at once (spec 20). The operator's setting, except
   * on a local loop provider: `omlx` owns the machine's unified memory, which
   * is the actual reason locked decision 5 gave for a serial queue, so that
   * queue stays serial however the setting reads. Ignored rather than
   * rejected, because the provider can change under a saved setting.
   */
  private concurrencyLimit(settings: Settings = getSettings()): number {
    if (normalizeProvider(settings.loopProvider, "anthropic") === "omlx") return 1;
    // Clamped to the same bounds the setting validates against, and 1 for
    // anything unreadable: a missing or hand-edited row must fail closed to
    // the serial queue rather than uncap the server.
    const configured = Math.trunc(Number(settings.maxConcurrentCards));
    return Number.isFinite(configured) ? Math.min(8, Math.max(1, configured)) : 1;
  }

  /** True while `repoId` has no free pipeline slot. */
  private pipelineBusy(repoId: string): boolean {
    return this.pipelineLoad(repoId) >= this.concurrencyLimit();
  }

  /** Throw a 409 while `repoId` has work that deleting the repo would orphan:
   * a harness run in flight (or a loop still tearing down), a card holding the
   * `reviewing` merge claim, or a running improvement run — including one
   * still proposing before it has created a card. Synchronous, so a caller can
   * delete the repo with no intervening await. */
  assertRepoRemovable(repoId: string): void {
    // Any load at all, not pipelineBusy: with a concurrency cap above 1 a repo
    // can have a run in flight and still have a free slot (spec 20).
    if (this.pipelineLoad(repoId) > 0 || this.cardInStatus(["reviewing"], repoId)) {
      throw new ClientError(
        "cannot remove a repository while one of its tasks is running or merging — cancel it or wait for it to finish",
        409,
      );
    }
    const improvementRun = db
      .select({ id: improvementRuns.id })
      .from(improvementRuns)
      .where(and(eq(improvementRuns.repoId, repoId), eq(improvementRuns.status, "running")))
      .limit(1)
      .get();
    if (improvementRun) {
      throw new ClientError(
        "cannot remove a repository with a running improvement run — stop it and wait for its current task to finish",
        409,
      );
    }
  }

  /** Advance every repo's queue independently. Each repo gets one pipeline
   * slot: a ready card loops before any new card in that repo is planned, and
   * nothing new starts while a card there is planning, looping, or
   * evaluating. Unrelated repos never wait on each other. */
  pump() {
    if (this.draining || this.passive) return;
    // One settings read per pump: getSettings() reads and decrypts the whole
    // table, and the slot loop below used to call it again on every pass.
    const settings = getSettings();

    // Read once, then filter per repo — preserving the tie-break order
    // (ready before todo, oldest startedAt/position first) within each repo.
    const readyCards = db
      .select()
      .from(cards)
      .where(eq(cards.status, "ready"))
      .orderBy(asc(cards.startedAt))
      .all();
    // Spec 24: a piece of an ordered epic waits for the pieces queued before
    // it. Only these automatic starts are held; Start now on the piece is the
    // operator overriding the order on purpose.
    const todoCards = db
      .select()
      .from(cards)
      .where(eq(cards.status, "todo"))
      .orderBy(asc(cards.position))
      .all()
      .filter((card) => !heldByEpicOrder(card));
    const autoMode = settings.autoMode;
    const limit = this.concurrencyLimit(settings);
    const eligibleTodoRepoIds = planningCandidates(todoCards, autoMode).map((c) => c.repoId);
    // Cards whose install gate cleared into a finished checklist while their
    // repo was at its cap (spec 20): evaluation is owed to them, not another
    // loop pass. The flag lives on the card row (spec 25) so any worker
    // sharing the database — or this one after a restart — can pick it up.
    const pendingEvaluationCards = db
      .select()
      .from(cards)
      .where(and(eq(cards.status, "needs_attention"), eq(cards.evaluationPending, 1)))
      .orderBy(asc(cards.updatedAt))
      .all();
    const repoIds = [
      ...new Set([
        ...readyCards.map((c) => c.repoId),
        ...eligibleTodoRepoIds,
        ...pendingEvaluationCards.map((c) => c.repoId),
      ]),
    ];

    for (const repoId of repoIds) {
      const repoReady = readyCards.filter((c) => c.repoId === repoId);
      // Cards approveInstallScripts queued for evaluating while this repo
      // was at its cap — oldest queued first, same tie-break as the others.
      const repoPendingEvaluations = pendingEvaluationCards.filter((c) => c.repoId === repoId).map((c) => c.id);
      /** Todo cards already handed to startCard in this pass. A planned card
       * that has a plan goes back to Ready rather than consuming a slot, and
       * startCard pumps again, so without this the loop would re-pick it from
       * the stale list forever. */
      const planned = new Set<string>();
      let nextReady = 0;
      let nextPendingEvaluation = 0;
      // Spec 20: fill every free slot this repo has rather than one card per
      // pump. pipelineLoad is re-read each pass, so a card started by a
      // nested pump() is counted before the next start decision.
      while (this.pipelineLoad(repoId) < limit) {
        const pendingEvaluationId = repoPendingEvaluations[nextPendingEvaluation++];
        if (pendingEvaluationId) {
          if (this.claimPendingEvaluation(pendingEvaluationId, repoId, limit)) {
            emitEvent("card.moved", {
              cardId: pendingEvaluationId,
              payload: { from: "needs_attention", to: "evaluating", reason: "install scripts approved" },
            });
            this.startStage("evaluating", pendingEvaluationId);
          }
          continue;
        }
        const readyCard = repoReady[nextReady++];
        if (readyCard) {
          // The claim is the guard: it moves the card to `looping` and
          // inserts its run row atomically, so a nested pump, another event
          // in this process, or another worker on the same database cannot
          // start it twice.
          const claim = this.claimLoopRun(readyCard.id);
          if (!claim) continue;
          const id = readyCard.id;
          void this.runLoop(claim)
            .catch((err) => {
              const reason = String(err);
              // A throw after the claim would otherwise leave the run row
              // `running` until the next recover().
              this.endActiveRun(id, "failed", reason);
              if (getCard(id)?.status === "looping") {
                this.moveCard(id, "looping", "needs_attention", reason);
              }
            })
            .finally(() => this.pump());
          continue;
        }

        // Ready is exhausted: plan the next eligible Todo card in this repo.
        // Backlog is never queried here.
        const next = planningCandidates(
          todoCards.filter((c) => c.repoId === repoId && !planned.has(c.id)),
          autoMode,
        )[0];
        if (!next) break;
        planned.add(next.cardId);
        try {
          this.startCard(next.cardId);
        } catch {
          // startCard throws on bad state — silently skip.
        }
      }
    }

    // Spec 25 decision 6: deliveries enqueued by a web process (or by this
    // one) wait here for a worker; run every one whose repo lease is free.
    this.reviewService.claimPendingDeliveries();
  }

  /**
   * Claim a queued evaluation (spec 25 decision 2): inside one `BEGIN
   * IMMEDIATE` transaction, check the card is still in Needs Attention with
   * the flag set — a human may have restarted or cancelled it while it
   * waited — and that the repo has a free slot, then move it to evaluating
   * and clear the flag. Two workers sharing the database cannot both win.
   */
  private claimPendingEvaluation(cardId: string, repoId: string, limit: number): boolean {
    return db.transaction(
      (tx) => {
        const fresh = tx
          .select({ status: cards.status, evaluationPending: cards.evaluationPending })
          .from(cards)
          .where(eq(cards.id, cardId))
          .get();
        if (fresh?.status !== "needs_attention" || fresh.evaluationPending !== 1) return false;
        if (this.loadFor(repoId, tx) >= limit) return false;
        const moved = tx
          .update(cards)
          .set({ status: "evaluating", evaluationPending: 0, updatedAt: now() })
          .where(and(eq(cards.id, cardId), eq(cards.status, "needs_attention")))
          .run();
        return moved.changes === 1;
      },
      { behavior: "immediate" },
    );
  }

  private async runLoop(claim: LoopClaim) {
    const { card, repo, plan, settings, runId, prev, provider, loopModel } = claim;
    const cardId = card.id;
    const maxIterations = card.maxIterations ?? settings.defaultMaxIterations;
    const timeoutMs = (card.timeoutMinutes ?? settings.defaultTimeoutMinutes) * 60 * 1000;

    const { worktreePath, branch, baseBranch, created } = await resolveWorktree(repo, card, runId, prev);
    db.update(runs).set({ worktreePath, branch, baseBranch }).where(eq(runs.id, runId)).run();
    if (created) recordWorktree(repo.id, runId, worktreePath, branch);
    // Ensure the worktree carries the current plan's artifacts.
    const ralphDir = ralphDirPath(worktreePath);
    const ralphFile = (name: string) => path.join(/* turbopackIgnore: true */ ralphDir, name);
    fs.mkdirSync(/* turbopackIgnore: true */ ralphDir, { recursive: true });
    // The private PLAN.md holds the task checklist the orchestrator ticks off —
    // its checked state is the loop's memory, so never clobber an existing
    // copy on restart. Adopt a legacy in-worktree copy (pre-private-plan
    // cards) so its ticks survive, then remove it: the loop agent must never
    // be able to read PLAN.md.
    const planPath = planStatePath(cardId);
    const legacyPlanPath = ralphFile("PLAN.md");
    if (!fs.existsSync(/* turbopackIgnore: true */ planPath)) {
      fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(planPath), { recursive: true });
      fs.writeFileSync(/* turbopackIgnore: true */ planPath, readFileIfExists(legacyPlanPath) || plan.planMd);
    }
    // CRITERIA.md is orchestrator-private like PLAN.md (the evaluator gets the
    // criteria injected into its prompt). Only PROMPT.md and the signal files
    // may remain in the worktree. PROMPT.md is the committed record of the
    // prompt on the run branch (the plan-sync commit below carries a newer
    // version onto a reused worktree, and the evaluator prompt names the
    // file); the iteration prompt itself is built from `plan.promptMd` and
    // never read back from here, because the loop agent's write root is the
    // whole worktree and a file it can edit must not become its next
    // instructions.
    removeRalphFiles(worktreePath, ["PLAN.md", "CRITERIA.md", ...DONE_FILE_NAMES]);
    fs.writeFileSync(/* turbopackIgnore: true */ ralphFile("PROMPT.md"), plan.promptMd);
    clearEvaluationArtifact(worktreePath);
    // A reused worktree (retry, restart) may have been left on another branch
    // by an earlier run's agent. Commit nothing to it; the run fails below,
    // once it has a row to fail.
    const offBranchAtStart = await offRunBranchReason(worktreePath, branch, repo.path);
    if (!offBranchAtStart) {
      await tryGit(worktreePath, "add", ".ralph");
      await tryGit(worktreePath, "commit", "-m", `ralph: sync plan v${plan.version}`);
    }

    // Spec 14 L3: per-run sandbox context and the parent-repo integrity
    // baseline. The baseline persists to disk because the pre-merge re-check
    // may run long after this process is gone.
    const ctx = await createRunSandbox(runId, { cwd: worktreePath, s: settings });
    db.update(runs).set({ diskLimitMechanism: ctx.diskLimitMechanism }).where(eq(runs.id, runId)).run();
    if (ctx.weakerIsolationEnabled) {
      emitEvent("sandbox.weaker_isolation_enabled", {
        cardId,
        runId,
        payload: { reason: "sandboxWeakerIsolationForGoTls" },
      });
    }
    // Multi-GB allocation — skipped under test, fire-and-forget otherwise.
    if (process.env.NODE_ENV !== "test") void ensureBallast(this.ballastPath());
    const integrityBaseline = await snapshotRepoIntegrity(repo.path);
    if (integrityBaseline) saveBaseline(runId, integrityBaseline);

    emitEvent("run.started", {
      cardId,
      runId,
      payload: { kind: "loop", maxIterations, timeoutMinutes: timeoutMs / 60000 },
    });

    // Register cancellation before provider preflight: preflight itself may
    // not be abortable, but its continuation is guarded below.
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    const active = () => this.isRunActive(runId, cardId, controller.signal);
    const fail = (reason: string, status: FinishStatus = "failed") => {
      // finishRun is false when something else already finalized this run
      // and moved the card: a cancel, a reset, a disk-watchdog trip. A stale
      // continuation must not then push a card that was re-queued — or is
      // running a NEW loop by now — into Needs Attention.
      if (!this.finishRun(runId, status, reason)) return;
      this.moveCard(cardId, "looping", "needs_attention", reason);
    };

    // Disk watchdog (spec 14 L3): a trip finalizes the run itself, then aborts
    // the harness — the abort-guard below treats that like a cancellation.
    const watchdog = startDiskWatchdog({
      paths: [worktreePath, ctx.root],
      ballastPath: this.ballastPath(),
      onTrip: (reason) => {
        if (this.finishRun(runId, "failed", reason)) {
          // Parity with endActiveRun: an open iteration row must not outlive
          // the run it belongs to.
          this.failIterations(runId, reason);
          this.moveCard(cardId, "looping", "needs_attention", reason);
        }
        controller.abort();
      },
    });

    try {
      if (offBranchAtStart) return fail(offBranchAtStart);
      const breaker = circuitOpenReason(provider);
      if (breaker) return fail(breaker);

      // Fail fast if the provider is down or not serving the model, rather
      // than spending iterations discovering it mid-run.
      try {
        await preflightProvider(provider, loopModel, settings);
        if (!active()) return;
      } catch (e) {
        if (!active()) return;
        return fail(`loop provider unreachable: ${errorMessage(e)}`);
      }

      const sandboxError = await sandboxUnavailableReason(settings);
      if (settings.sandboxEnabled && !active()) return;
      if (sandboxError) return fail(sandboxError);

      let model = loopModel;
      if (provider === "openrouter" && !loopModel) {
        return fail("no model selected for the OpenRouter provider — pick one in Settings");
      }
      if (provider === "omlx" && !loopModel) {
        try {
          const models = await listProviderModels("omlx", settings);
          if (!active()) return;
          if (!models[0]?.value) throw new Error("no models available from oMLX");
          model = models[0].value;
        } catch (e) {
          if (!active()) return;
          return fail(`failed to resolve oMLX model: ${errorMessage(e)}`);
        }
      }

      const deadline = Date.now() + timeoutMs;
      // Spec 11: per-iteration hard timeout, capped by the run's remaining
      // budget. The floor keeps a mistyped setting from making loops unrunnable.
      const hardTimeoutMs = Math.max(60_000, settings.iterationHardTimeoutMinutes * 60_000);
      let consecutiveFailures = 0;
      let consecutiveStalls = 0;
      /** Spec 18 §2: timeouts are counted for the whole run, not as a streak.
       * The streak reset on any iteration that did not time out, and the
       * timeout path always retries the same task — a retry that usually
       * succeeds in seconds against work already on disk. The counter was
       * measuring the retry's success rather than the run's health, and both
       * timeouts on the card this was measured against logged `consecutive: 1`. */
      let iterationTimeouts = 0;
      let consecutiveUnsignalled = 0;
      let remindSignal = false;
      let consecutiveBloat = 0;
      /** Spec 18 §7: the acceptance probe hands the loop one repair pass per
       * run and no more. A criterion can be permanently unsatisfiable — one on
       * the card this came from greps `.ralph/PLAN.md`, a file the loop is
       * deliberately forbidden to have — so an unbounded repair loop would
       * spin on it forever. */
      let acceptanceRepairUsed = false;
      /** Prompt size of every iteration that reported one, for the comparison
       * in promptBloatRatio(). Per run: a resumed run starts from a fresh
       * context, so the previous run's sizes are not its baseline. */
      const promptTokensSeen: number[] = [];
      /** Wall-clock of the iterations that advanced the checklist, feeding
       * iterationBudgetMs() so the run paces itself. Seeded from this card's
       * earlier iterations on this plan (spec 18 §8) so the bound applies from
       * the first iteration of a resumed run rather than the fourth — which is
       * what spec 11 intended and never got, because every run started
       * counting from zero. */
      const productiveMs: number[] = this.priorProductiveMs(cardId, plan.id);
      // Install-script gate trigger (spec 14): a changed lockfile fingerprint
      // after an iteration means an install happened. Each iteration's
      // after-fingerprint is the next one's before, so the tree is walked
      // once per iteration rather than twice.
      let lockfilesBefore = lockfileFingerprint(worktreePath);
      let n = 0;

      while (n < maxIterations) {
        const remaining = deadline - Date.now();
        if (remaining < 30_000) return fail("timeout", "timeout");
        // Every iteration needs an unchecked task to inject — there is no
        // fallback prompt. An exhausted checklist here means the final task
        // ended without a DONE signal (e.g. its criteria failed).
        const planMd = fs.readFileSync(/* turbopackIgnore: true */ planPath, "utf8");
        const task = firstUnchecked(planMd);
        // Nothing to inject means the final task was ticked without its DONE.
        // This ending belongs to the planner (`pendingReplanFeedback` turns it
        // into a re-plan on top of the branch), not to a retry of the loop.
        if (!task) return fail(CHECKLIST_EXHAUSTED_EXIT);
        n += 1;
        const transcriptFile = `iter-${String(n).padStart(3, "0")}.jsonl`;
        const iter = db
          .insert(iterations)
          .values({
            runId,
            n,
            transcriptPath: path.join(runTranscriptDir(runId), transcriptFile),
            taskNumber: task.taskNumber,
            taskCount: task.taskCount,
            taskText: task.item.text,
            startedAt: now(),
          })
          .returning()
          .get();
        emitEvent("iteration.started", { cardId, runId, payload: { n, maxIterations } });

        const preIteration = await captureIterationState(worktreePath);
        const before = await buildProgressState(worktreePath, planPath, preIteration);
        const budgetMs = iterationBudgetMs(hardTimeoutMs, productiveMs);
        // Soft signal only — spec 11 forbids terminating an iteration merely
        // for being slow; the hard timeout is the enforcement point.
        const slowMs = slowIterationMs(budgetMs);
        const slowTimer = setTimeout(() => {
          emitEvent("iteration.slow", { cardId, runId, payload: { n, thresholdMs: slowMs } });
        }, slowMs);
        const iterationStartedMs = Date.now();
        let result;
        try {
          result = await runWithTranscript({
            runId,
            file: transcriptFile,
            iteration: n,
            provider,
            model,
            reasoningLevel: settings.loopReasoningLevel,
            prompt: buildLoopPrompt(plan.promptMd, planMd) + (remindSignal ? SIGNAL_REMINDER : ""),
            cwd: worktreePath,
            timeoutMs: Math.min(remaining, budgetMs),
            signal: controller.signal,
            role: "loop",
            runContext: ctx,
          });
        } finally {
          clearTimeout(slowTimer);
        }

        // cancelCard already finalized, or the card moved on: nothing below
        // may touch a run that is no longer the live loop.
        if (!active()) return;

        const failed = Boolean(result.error) || result.code !== 0;
        db.update(iterations)
          .set({
            status: failed ? "failed" : "completed",
            summary: (result.error || result.lastText).slice(0, 2000) || null,
            endedAt: now(),
            ...runTelemetry(result),
            actualProvider: provider,
            actualModel: model || null,
          })
          .where(eq(iterations.id, iter.id))
          .run();
        db.update(runs).set({ iterationsDone: n }).where(eq(runs.id, runId)).run();
        emitEvent("iteration.completed", {
          cardId,
          runId,
          payload: { n, failed, stuck: result.stuck, summary: (result.error || result.lastText).slice(0, 200) },
        });

        // Every commit below lands on whatever branch the worktree has checked
        // out. The agent's git is meant to be read-only, but `git checkout` is
        // one command away, and the run-end integrity check would then read
        // the orchestrator's own commits on the base branch as tampering. Stop
        // here, before anything is committed.
        const offBranch = await offRunBranchReason(worktreePath, branch, repo.path);
        if (offBranch) return fail(offBranch);

        /**
         * Bank whatever the iteration left behind: tick and commit a signalled
         * task, surface a phantom, or record that nothing was signalled at all.
         *
         * Shared by the clean ending and the hard-timeout ending (spec 18 §1).
         * A killed iteration's `.ralph/ITERATION_DONE` is as real as any
         * other — the worktree survives a timeout either way, so reading a
         * signal file that is already there can only bank work the run would
         * otherwise discard and hand back to the next iteration as a task it
         * has already done.
         */
        const bankIteration = async () => {
          const bk = await performIterationBookkeeping({ ralphDir, worktreePath, planPath, pre: preIteration });
          if (bk?.advanced) {
            consecutiveUnsignalled = 0;
            remindSignal = false;
          } else if (bk) {
            // Phantom completion: ITERATION_DONE without any work product. The
            // checklist was NOT advanced, so the stall counter catches it.
            consecutiveUnsignalled = 0;
            remindSignal = false;
            emitEvent("iteration.phantom", {
              cardId,
              runId,
              payload: { n, taskNumber: bk.taskNumber, summary: bk.summary.slice(0, 200) },
            });
          } else {
            // The agent settled without writing ITERATION_DONE at all. Any work
            // it did is uncommitted and the checklist did not move, but the
            // files it touched make the stall check see progress, so nothing
            // else bounds this. Remind it once, then give up: repeating the
            // task a third time has never yet produced the signal.
            consecutiveUnsignalled += 1;
            emitEvent("iteration.unsignalled", {
              cardId,
              runId,
              payload: { n, taskNumber: task.taskNumber, attempt: consecutiveUnsignalled },
            });
            remindSignal = true;
          }
          return bk;
        };

        // A premature DONE must not skip the remaining tasks or let done
        // bookkeeping credit the NEXT task after ITERATION_DONE credits this one.
        // Remove both spellings before normal bookkeeping so neither is committed
        // or counted as work product. Valid task work still advances normally.
        if (!task.isLastUnchecked) removeRalphFiles(worktreePath, DONE_FILE_NAMES);

        // The loop's honest way out of a task it cannot do (see
        // taskInjectionBlock): a `.ralph/BLOCKED` note wins over any completion
        // signal written alongside it, so a blocked task is never ticked. The
        // blocker becomes this run's feedback — what the planner re-plans
        // around — and joins the card's scoping thread, where the operator
        // answers it (spec 17, backward direction).
        const blockedPath = ralphFile("BLOCKED");
        if (fs.existsSync(/* turbopackIgnore: true */ blockedPath)) {
          const blocker =
            fs.readFileSync(/* turbopackIgnore: true */ blockedPath, "utf8").trim() ||
            "(the loop reported a blocker without saying what it was)";
          removeRalphFiles(worktreePath, ["BLOCKED", "ITERATION_DONE", ...DONE_FILE_NAMES]);
          db.update(runs).set({ feedback: blocker }).where(eq(runs.id, runId)).run();
          addScopingMessage(cardId, "loop", blocker);
          emitEvent("loop.blocked", {
            cardId,
            runId,
            payload: { n, taskNumber: task.taskNumber, blocker: blocker.slice(0, 500) },
          });
          return fail(LOOP_BLOCKED_EXIT);
        }

        // DONE is the trigger for independent evaluation, not a direct pass to
        // review. Consume a same-iteration ITERATION_DONE first so the final
        // task gets its own deterministic commit; performDoneBookkeeping then
        // can only tick the final task if ITERATION_DONE was absent.
        if (doneFilePath(ralphDir)) {
          await performIterationBookkeeping({ ralphDir, worktreePath, planPath, pre: preIteration });
          await performDoneBookkeeping({ ralphDir, worktreePath, planPath });
          recordTaskCompleted(iter.id, planPath, task.taskNumber);
          // Spec 14 L3 run-end ordering: reap, verify parent-repo integrity,
          // then the install gate (forced — nothing unapproved may reach the
          // evaluator), and only then hand over to evaluation.
          const violation = await integrityViolationReason(ctx, repo.path, integrityBaseline, branch);
          if (violation) return fail(violation);
          if (await this.checkInstallGate({ cardId, runId, repoId: repo.id, worktreePath })) return;

          // Spec 18 §7: DONE is the model's own word, and an evaluation is the
          // most expensive thing the pipeline does. Run the acceptance
          // criteria's own check commands first. Only their failures are
          // trusted — a zero exit proves nothing, since a criterion can carry
          // a judgment a shell cannot make.
          if (!acceptanceRepairUsed) {
            const probe = await runAcceptanceProbe({
              acceptanceCriteria: plan.acceptanceCriteria,
              worktreePath,
              ctx,
            });
            const failures = probe.filter((p) => !p.ok);
            if (probe.length > 0) {
              emitEvent("acceptance.probe", {
                cardId,
                runId,
                payload: {
                  n,
                  checked: probe.length,
                  failed: failures.map((f) => ({ command: f.command, output: f.output })),
                },
              });
            }
            if (failures.length > 0) {
              acceptanceRepairUsed = true;
              // Clear the signal, or the next iteration re-enters this branch
              // before doing the repair.
              removeRalphFiles(worktreePath, DONE_FILE_NAMES);
              // Every iteration runs on an injected checklist task, so the
              // repair has to be one — a prompt preamble alone never runs.
              fs.writeFileSync(
                /* turbopackIgnore: true */ planPath,
                appendTask(fs.readFileSync(/* turbopackIgnore: true */ planPath, "utf8"), repairTaskText(failures)),
              );
              continue;
            }
          }
          // Both gated: a cancel or reset that landed during the awaited
          // bookkeeping above has already finalized this run and moved the
          // card, and must not be followed by an evaluator run for it.
          if (!this.finishRun(runId, "completed", "done-signal")) return;
          // Phase 3: every DONE goes through the evaluator before a human
          // sees it. An evaluator crash is a loud failure, not a pass-through.
          // A card paused during its final iteration still gets evaluated.
          const status = getCard(cardId)?.status;
          if ((status === "looping" || status === "paused") && this.moveCard(cardId, status, "evaluating")) {
            this.startStage("evaluating", cardId);
          }
          return;
        }
        if (result.timedOut) {
          // Spec 18 §1: bank before deciding anything. An agent that finished
          // its task seconds before the kill has its tick and its commit, and
          // one that was killed mid-thought is counted as unsignalled here —
          // the missing-signal path below never runs on this branch, so
          // without this the retry gets the identical prompt that just ran
          // out of time. The elapsed time is deliberately NOT fed to
          // productiveMs: a killed iteration demonstrates nothing about the
          // pace a productive one keeps.
          const banked = await bankIteration();
          recordTaskCompleted(iter.id, planPath, task.taskNumber);
          if (banked?.advanced) consecutiveStalls = 0;
          // When the iteration budget WAS the remaining run budget, this is
          // the run-level wall-clock cap — final.
          if (remaining <= budgetMs) return fail("timeout", "timeout");
          // Per-iteration hard timeout: one retry with the worktree
          // preserved; a second timeout anywhere in the run ends it (spec 11,
          // amended by spec 18 §2).
          iterationTimeouts += 1;
          emitEvent("iteration.timeout", {
            cardId,
            runId,
            payload: { n, hardTimeoutMs, budgetMs, timeoutsThisRun: iterationTimeouts },
          });
          if (iterationTimeouts >= 2) return fail("iteration-timeout", "timeout");
          continue;
        }
        if (failed) {
          consecutiveFailures += 1;
          // A first-iteration connection/auth failure means the provider is
          // down or misconfigured — no point retrying.
          // A limit error means the allowance is gone, not that this
          // iteration was unlucky. Stop the run on the first one rather than
          // spending the remaining failure budget re-hitting the same wall.
          const failureKind = recordProviderFailure(provider, result.error);
          const isConnErr = failureKind === "conn";
          const isLimitErr = failureKind === "limit";
          // A rejected request is rejected the same way every time. Spending
          // the remaining failure budget rediscovering that is pure waste.
          const isConfigErr = failureKind === "config";
          if (consecutiveFailures >= 3 || isLimitErr || isConfigErr || (n === 1 && isConnErr)) {
            return fail(`loop failed: ${result.error.slice(0, 300)}`);
          }
          continue;
        }
        consecutiveFailures = 0;
        recordProviderOutcome(provider, true);

        // Handle the ITERATION_DONE signal: the orchestrator performs the
        // checklist tick and commit — the agent never does.
        const bkResult = await bankIteration();
        if (bkResult?.advanced) {
          consecutiveStalls = 0;
          productiveMs.push(Date.now() - iterationStartedMs);
        } else if (!bkResult && consecutiveUnsignalled >= 2) {
          return fail("loop ended two iterations without writing .ralph/ITERATION_DONE");
        }
        recordTaskCompleted(iter.id, planPath, task.taskNumber);

        // Install-script gate (spec 14): fire on any lockfile change, after
        // bookkeeping so a resumed run starts its next iteration cleanly.
        const lockfilesAfter = lockfileFingerprint(worktreePath);
        const installHappened = lockfilesAfter !== lockfilesBefore;
        lockfilesBefore = lockfilesAfter;
        if (
          installHappened &&
          (await this.checkInstallGate({ cardId, runId, repoId: repo.id, worktreePath }))
        ) {
          return;
        }

        if ((await buildProgressState(worktreePath, planPath)) === before) {
          consecutiveStalls += 1;
          if (consecutiveStalls >= 3) return fail("stalled");
        } else {
          consecutiveStalls = 0;
        }

        // Spec 18 §9: prompt growth is the one runaway nothing watched. On the
        // card this came from, a loop run's prompt tokens went 645k, 1.9M,
        // 3.2M, 6.8M on the same branch and the same plan, with no event and
        // no ceiling. One bloated iteration is worth saying out loud; two in a
        // row is a context that is not going to come back down.
        const bloat = promptBloatRatio(result.promptTokens, promptTokensSeen);
        if (bloat !== null && bloat >= BLOAT_MULTIPLIER) {
          consecutiveBloat += 1;
          emitEvent("iteration.bloat", {
            cardId,
            runId,
            payload: {
              n,
              promptTokens: result.promptTokens,
              ratio: Math.round(bloat * 10) / 10,
              consecutive: consecutiveBloat,
            },
          });
          if (consecutiveBloat >= 2) {
            return fail(`prompt grew to ${Math.round(bloat)}x the run's median for two iterations`);
          }
        } else {
          consecutiveBloat = 0;
        }
        if (result.promptTokens) promptTokensSeen.push(result.promptTokens);

        // Spec 25 decision 4: a pause requested from another process shows
        // up as the card status and as `runs.control`; either is enough.
        const control = db.select({ control: runs.control }).from(runs).where(eq(runs.id, runId)).get()?.control;
        if (getCard(cardId)?.status === "paused" || control === "pause") {
          // The card already moved when the pause was requested (spec 25
          // decision 4); only the run needs closing here. Not "completed"
          // (spec 18 §6): the operator stopped this run, it did not achieve
          // anything. Scoring it as a success put a run that spent 51.6
          // minutes on one unfinished task in the numerator of the success
          // rate.
          this.finishRun(runId, "paused", "paused by user");
          return;
        }

        // Shutdown reached us between iterations: everything up to here is
        // committed and ticked, so stop on the boundary and hand the card
        // back to Ready. recover() resumes it on the next boot, having lost
        // nothing. A drain that runs out of time mid-iteration still exits
        // hard, and that path costs the one iteration.
        if (this.draining) {
          this.finishRun(runId, "interrupted", "stopped for restart");
          this.moveCard(cardId, "looping", "ready", "stopped for restart");
          return;
        }
      }
      fail("max-iterations");
    } finally {
      watchdog.stop();
      this.controllers.delete(runId);
      // A cancel written by a web-only process between the claim and
      // `this.controllers.set(runId, controller)` is never seen by
      // applyControlSignals(), so the owner clears it here (a `pause` value is
      // left untouched — the loop records it at the iteration boundary).
      db.update(runs).set({ control: null }).where(and(eq(runs.id, runId), eq(runs.control, "cancel"))).run();
      // Reaps every recorded process group, then removes the run-private
      // TMPDIR/caches — on every exit path including failure and cancel.
      await ctx.cleanup();
    }
  }

  /**
   * How long this card's earlier iterations on this plan took, for the ones
   * that both completed and ticked their task (spec 18 §8).
   *
   * Scoped to the plan because a re-plan changes what a task is, so durations
   * from the previous checklist say nothing about this one. Both conditions
   * matter: an iteration killed by the hard timeout can now tick its task
   * (§1), and seeding the budget with a full hard-timeout duration is exactly
   * the poisoning this is meant to avoid.
   */
  private priorProductiveMs(cardId: string, planId: string): number[] {
    return db
      .select({ startedAt: iterations.startedAt, endedAt: iterations.endedAt })
      .from(iterations)
      .innerJoin(runs, eq(iterations.runId, runs.id))
      .where(
        and(
          eq(runs.cardId, cardId),
          eq(runs.planId, planId),
          eq(runs.kind, "loop"),
          eq(iterations.status, "completed"),
          eq(iterations.taskCompleted, 1),
        ),
      )
      .all()
      .map((row) => (row.endedAt ? Date.parse(row.endedAt) - Date.parse(row.startedAt) : NaN))
      .filter((ms) => Number.isFinite(ms) && ms > 0);
  }

  /** Shared ballast file (spec 14): dead weight deleted on disk pressure so
   * the machine stays usable while a runaway run is being stopped. */
  private ballastPath(): string {
    return path.join(/* turbopackIgnore: true */ runScratchRoot(), "ballast");
  }

  /**
   * Install-script gate (spec 14). When any package in the worktree's resolved
   * dependency tree has lifecycle scripts unapproved for this repo, halt the
   * run into Needs Attention with the verbatim script bodies in the event
   * payload. Returns true when the gate fired. The model never sees a prompt.
   */
  private async checkInstallGate(opts: {
    cardId: string;
    runId: string;
    repoId: string;
    worktreePath: string;
  }): Promise<boolean> {
    const repo = getRepo(opts.repoId);
    if (!repo) return false;
    const unapproved = unapprovedScripts(await collectLifecycleScripts(opts.worktreePath), approvedScripts(repo));
    if (unapproved.length === 0) return false;

    emitEvent("install.gate", {
      cardId: opts.cardId,
      runId: opts.runId,
      payload: {
        packages: unapproved.map(({ name, version, scripts, scriptHash }) => ({ name, version, scripts, scriptHash })),
      },
    });
    // The run pauses with its state preserved (worktree + checklist ticks);
    // approval resumes it in place rather than requeueing to Todo.
    const names = unapproved.map((p) => `${p.name}@${p.version}`).join(", ");
    this.finishRun(opts.runId, "completed", "install-script gate");
    this.moveCard(opts.cardId, "looping", "needs_attention", `install-script gate: unapproved lifecycle scripts in ${names}`);
    return true;
  }

  /**
   * Approve specific packages' lifecycle scripts for a gate-halted card:
   * `npm rebuild` for the approved packages ONLY, record them in the repo's
   * approved list, and resume the paused run in place — back to the loop
   * queue, or straight to evaluation when the checklist finished before the
   * gate fired.
   */
  async approveInstallScripts(cardId: string, packages: ApprovedInstallScript[]): Promise<{ ok: true }> {
    const card = requireCard(cardId);
    if (card.status !== "needs_attention") {
      throw new ClientError(`cannot approve install scripts for a ${card.status} card`);
    }
    if (packages.length === 0) throw new ClientError("no packages to approve");
    if (this.passive) {
      throw new ClientError("this process only serves the UI; a process with the worker role has to run this", 409);
    }
    const run = this.latestWorktreeRun(cardId);
    if (!run) throw new ClientError("card has no worktree left to resume");
    const repo = requireRepo(card.repoId);

    // Approve only what is actually present in the resolved tree, matched on
    // the full {name, version, scriptHash} triple — a stale UI payload must
    // not approve a script body the human never saw.
    const requested = new Set(packages.map(scriptKey));
    const present = (await collectLifecycleScripts(run.worktreePath)).filter((p) => requested.has(scriptKey(p)));
    if (present.length === 0) {
      throw new ClientError(
        "none of the requested packages match the worktree's resolved tree — re-open the card to see the current gate state",
      );
    }

    // The rebuild runs the approved scripts inside the same containment the
    // agent had, not on the host: the worktree's `.npmrc` and the rest of the
    // tree are agent-authored. Same fail-loud rule as a run: never fall back
    // to an unsandboxed rebuild because the runtime is broken.
    const settings = getSettings();
    const sandboxError = await sandboxUnavailableReason(settings);
    if (sandboxError) throw new ClientError(sandboxError);
    const ctx = await createRunSandbox(`${run.id}-rebuild`, { cwd: run.worktreePath, s: settings });
    let rebuild: { ok: boolean; out: string };
    try {
      rebuild = await rebuildPackages(
        run.worktreePath,
        [...new Set(present.map((p) => p.name))],
        sandboxedNpmRunner(ctx),
      );
    } finally {
      await ctx.cleanup();
    }
    if (!rebuild.ok) throw new ClientError(`npm rebuild failed: ${rebuild.out.slice(0, 500)}`);

    // Transaction, and re-read inside it: with more than one card in flight
    // (spec 20) two gates can clear at the same moment, and a read-modify-write
    // off the row this call captured earlier would drop the other's approvals.
    db.transaction((tx) => {
      const current = tx.select().from(repos).where(eq(repos.id, repo.id)).get() ?? repo;
      const approved = approvedScripts(current);
      const keys = new Set(approved.map(scriptKey));
      for (const { name, version, scriptHash } of present) {
        const entry = { name, version, scriptHash };
        if (!keys.has(scriptKey(entry))) {
          keys.add(scriptKey(entry));
          approved.push(entry);
        }
      }
      tx.update(repos)
        .set({ approvedInstallScripts: JSON.stringify(approved) })
        .where(eq(repos.id, repo.id))
        .run();
    });
    emitEvent("install.approved", {
      cardId,
      runId: run.id,
      payload: {
        packages: present.map((p) => `${p.name}@${p.version}`),
        // Same stamp a run row carries, so "did the approved scripts run
        // contained" is answerable from the card's history.
        sandboxed: ctx.srtConfig !== undefined,
      },
    });

    // Resume in place. A checklist with no unchecked task means the gate
    // fired on the DONE path — evaluation is next, not another loop run.
    const planMd = readPlanState(cardId);
    if (planMd && !firstUnchecked(planMd)) {
      // Needs_attention carries no pipeline load (RUNNING_STATUSES doesn't
      // include it), so this card can queue up behind another one already
      // holding the repo's only slot. Starting evaluating straight away
      // would push the repo over its cap (spec 20) — queue it the same way
      // the ready branch below does, but for evaluating: pump() resumes it,
      // still skipping the loop, once a slot is free. The queue is the
      // card row's evaluationPending flag (spec 25), so it survives a
      // restart and is visible to every worker on the database.
      if (this.claimStage(cardId, "needs_attention", "evaluating", "install scripts approved")) {
        this.startStage("evaluating", cardId);
      } else if (getCard(cardId)?.status === "needs_attention") {
        db.update(cards).set({ evaluationPending: 1, updatedAt: now() }).where(eq(cards.id, cardId)).run();
        emitEvent("card.evaluation_queued", {
          cardId,
          payload: { reason: "install scripts approved while the repo was at its cap" },
        });
      }
    } else {
      this.moveCard(cardId, "needs_attention", "ready", "install scripts approved");
      this.pump();
    }
    return { ok: true };
  }

  // ---- review actions ------------------------------------------------------

  approvePlan(cardId: string) {
    return this.reviewService.approvePlan(cardId);
  }

  approve(runId: string) {
    return this.reviewService.approve(runId);
  }

  retryMerge(cardId: string, configApproval?: ConfigApproval) {
    return this.reviewService.retryMerge(cardId, configApproval);
  }

  reviewConfig(cardId: string) {
    return this.reviewService.reviewConfig(cardId);
  }

  reject(runId: string, feedback: string) {
    return this.reviewService.reject(runId, feedback);
  }

  abandon(cardId: string) {
    return this.reviewService.abandon(cardId);
  }

  async resetCard(cardId: string) {
    const card = requireCard(cardId);
    // The UI offers a reset from exactly these; hold the route to the same
    // rule. A reset mid-run deletes the run rows and plan under a loop whose
    // awaited continuation is still writing to them, and a reset during the
    // `reviewing` claim deletes the run row the merge is about to record its
    // review against, after the merge has already landed on the base branch.
    if (!["needs_attention", "review", "plan_review"].includes(card.status)) {
      throw new ClientError(`cannot reset card in status ${card.status}`, 409);
    }
    const repo = requireRepo(card.repoId);
    this.endActiveRun(cardId, "cancelled", "reset by user");

    // Remove worktrees for ALL runs before deleting their rows.
    const allRuns = db.select().from(runs).where(eq(runs.cardId, cardId)).all();
    for (const run of allRuns) {
      if (fs.existsSync(/* turbopackIgnore: true */ run.worktreePath)) {
        await removeWorktree(repo.path, run.worktreePath, run.branch);
      }
      removeBaseline(run.id);
    }
    await removeRunTranscripts(allRuns.map((run) => run.id));

    // Runs cascade to iterations + reviews.
    db.delete(runs).where(eq(runs.cardId, cardId)).run();
    db.delete(plans).where(eq(plans.cardId, cardId)).run();
    db.delete(events).where(eq(events.cardId, cardId)).run();
    fs.rmSync(/* turbopackIgnore: true */ planStatePath(cardId), { force: true });
    db.update(cards)
      .set({ summary: null, startedAt: null, updatedAt: now() })
      .where(eq(cards.id, cardId))
      .run();

    this.moveCard(cardId, card.status, "backlog", "reset");
  }
}

// Survive Next.js dev hot-reload: one orchestrator per process.
//
// Hazard: instrumentation.ts (which constructs this singleton) and a route
// handler can end up in different module graphs, so `instanceof` on a class
// thrown through the orchestrator (e.g. ClientError) is unreliable across
// that boundary. See src/app/api/_lib.ts's `isClientError` for the fallback.
const g = globalThis as unknown as { __radulfOrchestrator?: Orchestrator };

export function getOrchestrator(): Orchestrator {
  // A web-only process gets a passive orchestrator: the worker owns recovery,
  // the pump and every stage; this one only moves cards for operator actions.
  return (g.__radulfOrchestrator ??= new Orchestrator(hasRole("worker") ? {} : { passive: true }));
}
