import fs from "node:fs";
import path from "node:path";
import { and, asc, desc, eq, inArray, max } from "drizzle-orm";
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
  type ApprovedInstallScript,
  type CardStatus,
} from "@/db";
import { emitEvent } from "./events";
import { getSettings } from "./settings";
import {
  buildLoopPrompt,
  buildProgressState,
  captureIterationState,
  performIterationBookkeeping,
  performDoneBookkeeping,
  planStatePath,
} from "./bookkeeping";
import { appendTask, firstUnchecked, parseChecklist } from "./checklist";
import { SLOW_ITERATION_MS } from "./analytics";
import { TELEMETRY_KEYS, runTelemetry, type RunTelemetry } from "./harness";
import { listProviderModels, normalizeProvider, preflightProvider } from "./providers";
import { classifyProviderError, recordProviderOutcome } from "./circuitBreaker";
import { diagnosisMessage, misconfiguredStage } from "./stageDiagnosis";
import { postAlert } from "./alerts";
import { repairTaskText, runAcceptanceProbe } from "./acceptanceProbe";
import { limitCooldownMs } from "./providerRateLimit";
import { offRunBranchReason, removeWorktree, tryGit } from "./git";
import { removeRunTranscripts, runTranscriptDir } from "./retention";
import { PlanningService, pendingReplanFeedback } from "./planningService";
import { EvaluationService, clearEvaluationArtifact } from "./evaluationService";
import { ReviewService } from "./reviewService";
import { ClientError } from "./clientError";
import { CHECKLIST_EXHAUSTED_EXIT, LOOP_BLOCKED_EXIT, retryableFailedStep } from "@/shared/failedStep";
import { addScopingMessage } from "./scoping";
import { createRunSandbox, runScratchRoot } from "./sandbox/context";
import { ensureBallast, startDiskWatchdog } from "./sandbox/diskWatchdog";
import {
  registerRunBaseline,
  releaseRunBaseline,
  removeBaseline,
  saveBaseline,
  snapshotRepoIntegrity,
} from "./integrity";
import {
  collectLifecycleScripts,
  lockfileFingerprint,
  rebuildPackages,
  unapprovedScripts,
} from "./installGate";
import {
  circuitOpenReason,
  integrityViolationReason,
  resolveWorktree,
  runWithTranscript,
  sandboxUnavailableReason,
  startRunRow,
  type FinishStatus,
  type StageDependencies,
} from "./stage";

type Card = typeof cards.$inferSelect;
type Run = typeof runs.$inferSelect;

const HARNESS_STATUSES: CardStatus[] = ["planning", "looping", "evaluating"];

/** How often to look for a card that has been waiting on a human (spec 18 §5).
 * Well under the smallest useful staleness setting — the setting decides when
 * to speak, this only decides how often to look. */
const ATTENTION_SWEEP_MS = 60_000;

/** An event payload, or an empty object when the row is unreadable. Corrupt
 * JSON in one event must never stop a sweep. */
function parsePayload(payload: string): Record<string, unknown> {
  try {
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Small models write DONE.md as often as DONE — accept both. */
export function doneFilePath(ralphDir: string): string | null {
  for (const name of ["DONE", "DONE.md"]) {
    const p = path.join(/* turbopackIgnore: true */ ralphDir, name);
    if (fs.existsSync(/* turbopackIgnore: true */ p)) return p;
  }
  return null;
}

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

const scriptKey = (p: ApprovedInstallScript) => `${p.name}@${p.version}#${p.scriptHash}`;

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

export class Orchestrator {
  /** Card ID → repoId for every async loop currently running in the
   * background, so pipelineBusy(repoId) needs no extra DB round-trip. */
  private activeLoopCards = new Map<string, string>();
  /** Card IDs that have requested a pause on next iteration boundary. */
  private pausedCards = new Set<string>();
  /** Set on graceful shutdown: pump() starts no new runs, and a running loop
   * stops at its next iteration boundary. */
  private draining = false;
  /** runId → controller for every live harness invocation. */
  private controllers = new Map<string, AbortController>();

  private stageDeps: StageDependencies = {
    getCard: (cardId) => this.getCard(cardId),
    latestPlan: (cardId) => this.latestPlan(cardId),
    latestWorktreeRun: (cardId) => this.latestWorktreeRun(cardId),
    moveCard: (cardId, from, to, reason) => this.moveCard(cardId, from, to, reason),
    finishRun: (runId, status, exitReason, telemetry) =>
      this.finishRun(runId, status, exitReason, undefined, telemetry),
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
  private reviewService = new ReviewService({ ...this.stageDeps, pump: () => this.pump() });

  /** Spec 18 §5 sweep timer, held so startDraining() can stop it. */
  private attentionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: { autoStart?: boolean } = {}) {
    if (options.autoStart !== false) {
      this.recover();
      this.pump();
      this.attentionTimer = setInterval(() => this.sweepStaleAttention(), ATTENTION_SWEEP_MS);
      // Never hold the process open for a sweep (same reasoning as the disk
      // watchdog): this is a reminder, not work.
      this.attentionTimer.unref?.();
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
    for (const card of waiting) {
      const cardEvents = db
        .select()
        .from(events)
        .where(eq(events.cardId, card.id))
        .orderBy(desc(events.id))
        .all();
      // Walking back by event id rather than by timestamp: the newest of
      // these two decides. An announcement first means this entry has already
      // been announced; the move first means it has not.
      const marker = cardEvents.find(
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
    const stale = db.select().from(runs).where(eq(runs.status, "running")).all();
    for (const run of stale) {
      db.update(runs)
        .set({ status: "interrupted", exitReason: "server restarted mid-run", endedAt: now() })
        .where(eq(runs.id, run.id))
        .run();
      this.failIterations(run.id, "interrupted by server restart");
      emitEvent("run.finished", {
        cardId: run.cardId,
        runId: run.id,
        payload: { status: "interrupted" },
      });
    }
    // No run survives a restart, so the per-run scratch root (private TMPDIRs,
    // caches, pgid files) is all stale — sweep it before anything new starts.
    fs.rmSync(/* turbopackIgnore: true */ runScratchRoot(), { recursive: true, force: true });
    // Any card still marked planning/looping/evaluating lost its run. A
    // reviewing card lost the in-process merge claim.
    const orphans = db
      .select()
      .from(cards)
      .where(inArray(cards.status, [...HARNESS_STATUSES, "reviewing"]))
      .all();
    for (const card of orphans) {
      // A loop is checkpointed: the orchestrator commits every finished
      // iteration and ticks the private plan checklist, so a restart costs at
      // most the one iteration that was in flight. Put a resumable card back
      // in Ready and let pump() open a fresh loop run on the first unchecked
      // task, instead of making a human press Retry to lose nothing. Every
      // other stage re-runs from the top, so those still need a human.
      if (card.status === "looping" && this.loopIsResumable(card.id)) {
        this.moveCard(card.id, "looping", "ready", "resuming after restart");
        continue;
      }
      this.moveCard(card.id, card.status, "needs_attention", "interrupted");
    }
  }

  /** Whether a restarted loop can pick up where it left off: the plan it was
   * executing is still on disk with an unchecked task left in it, and the
   * worktree holding the committed iterations still exists. A plan with every
   * task ticked is finishing, not resuming, so it goes to a human too. */
  private loopIsResumable(cardId: string): boolean {
    if (!this.latestPlan(cardId)) return false;
    const planPath = planStatePath(cardId);
    if (!fs.existsSync(/* turbopackIgnore: true */ planPath)) return false;
    const planMd = fs.readFileSync(/* turbopackIgnore: true */ planPath, "utf8");
    if (!firstUnchecked(planMd)) return false;
    const worktreePath = this.latestWorktreeRun(cardId)?.worktreePath;
    return worktreePath !== undefined && fs.existsSync(/* turbopackIgnore: true */ worktreePath);
  }

  // ---- helpers -------------------------------------------------------------

  private getCard(cardId: string): Card | undefined {
    return db.select().from(cards).where(eq(cards.id, cardId)).get();
  }

  private requireCard(cardId: string): Card {
    const card = this.getCard(cardId);
    if (!card) throw new ClientError("card not found", 404);
    return card;
  }

  private moveCard(cardId: string, from: CardStatus, to: CardStatus, reason?: string): boolean {
    const result = db
      .update(cards)
      .set({ status: to, updatedAt: now() })
      .where(and(eq(cards.id, cardId), eq(cards.status, from)))
      .run();
    if (result.changes !== 1) return false;
    emitEvent("card.moved", { cardId, payload: { from, to, ...(reason ? { reason } : {}) } });
    return true;
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
      if (this.getCard(cardId)?.status === stage) {
        this.moveCard(cardId, stage, "needs_attention", String(err));
      }
    });
  }

  /** Mark a run finished — only if it is still `running` (guards cancel races). */
  private finishRun(
    runId: string,
    status: FinishStatus,
    exitReason: string,
    iterationsDone?: number,
    telemetry?: RunTelemetry,
  ): boolean {
    const run = db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!run || run.status !== "running") return false;
    // A pause request only applies to the live loop — a run that ends for any
    // other reason (cancel, DONE, timeout) must not pause the card's next run.
    this.pausedCards.delete(run.cardId);
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
    db.update(runs)
      .set({
        status,
        exitReason,
        failureKind,
        endedAt: now(),
        ...(iterationsDone !== undefined ? { iterationsDone } : {}),
        ...(rollup ?? {}),
      })
      .where(eq(runs.id, runId))
      .run();
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
    return run?.status === "running" && this.getCard(cardId)?.status === "looping";
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

  /** Cancel the card's live run, if any, and abort its harness. */
  private cancelActiveRun(cardId: string, reason: string) {
    const active = db
      .select()
      .from(runs)
      .where(and(eq(runs.cardId, cardId), eq(runs.status, "running")))
      .orderBy(desc(runs.startedAt))
      .limit(1)
      .get();
    if (!active) return;
    this.finishRun(active.id, "cancelled", reason);
    this.failIterations(active.id, reason);
    this.controllers.get(active.id)?.abort();
  }

  // ---- entry points --------------------------------------------------------

  /** Todo → In Progress. Plans if needed, otherwise queues for the loop slot. */
  startCard(cardId: string) {
    const card = this.requireCard(cardId);
    if (!["todo", "needs_attention"].includes(card.status))
      throw new ClientError(`cannot start card in status ${card.status}`);
    if (!card.startedAt)
      db.update(cards).set({ startedAt: now() }).where(eq(cards.id, cardId)).run();

    if (this.latestPlan(cardId) && !pendingReplanFeedback(cardId)) {
      // Restart path — plan exists, go straight to the loop queue. Unplanned
      // feedback (a rejection or an evaluator revise) re-plans first.
      this.moveCard(cardId, card.status, "ready");
      this.pump();
    } else if (this.pipelineBusy(card.repoId)) {
      // One ticket runs at a time. The startedAt set above marks this a manual
      // start; land it back in todo (pump only scans todo for planning) so it
      // is picked up, oldest manual start first, when the pipeline frees.
      if (card.status !== "todo") {
        this.moveCard(cardId, card.status, "todo", "queued for planning");
      }
    } else {
      this.moveCard(cardId, card.status, "planning");
      this.startStage("planning", cardId);
    }
  }

  /** Backlog → Todo. Auto-mode may immediately claim the queued card. */
  queueCard(cardId: string) {
    const card = this.requireCard(cardId);
    if (card.status !== "backlog") {
      throw new ClientError(`cannot queue card in status ${card.status}`);
    }
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

  pauseCard(cardId: string) {
    const card = this.requireCard(cardId);
    if (card.status !== "looping") throw new ClientError(`cannot pause a ${card.status} card`);
    this.pausedCards.add(cardId);
  }

  resumeCard(cardId: string) {
    const card = this.requireCard(cardId);
    if (card.status !== "paused") throw new ClientError(`cannot resume a ${card.status} card`);
    this.pausedCards.delete(cardId);
    this.moveCard(cardId, "paused", "ready");
    this.pump();
  }

  cancelCard(cardId: string) {
    const card = this.requireCard(cardId);
    this.cancelActiveRun(cardId, "cancelled by user");
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
    const card = this.requireCard(cardId);
    if (card.status !== "needs_attention")
      throw new ClientError(`cannot restart card in status ${card.status}`);
    this.startCard(cardId);
  }

  /** Retry the latest failed pipeline stage without replaying completed ones. */
  retryFailedStep(cardId: string): { ok: true; step: NonNullable<ReturnType<typeof retryableFailedStep>> } {
    const card = this.requireCard(cardId);
    const step = retryableFailedStep(db.select().from(runs).where(eq(runs.cardId, cardId)).all());
    if (!step) throw new ClientError("the latest pipeline step did not fail");
    if (card.status !== "needs_attention") {
      throw new ClientError(`cannot retry ${step} for card in status ${card.status}`);
    }

    if (step === "loop") {
      if (!this.latestPlan(cardId)) throw new ClientError("card has no plan to retry");
      if (!this.moveCard(cardId, "needs_attention", "ready", "retrying failed loop")) {
        throw new ClientError("card status changed before the loop could retry");
      }
      this.pump();
      return { ok: true, step };
    }

    if (this.pipelineBusy(card.repoId)) throw new ClientError("another task is already being worked on");
    const [stage, agent] = step === "plan"
      ? (["planning", "planner"] as const)
      : (["evaluating", "evaluator"] as const);
    if (!this.moveCard(cardId, "needs_attention", stage, `retrying failed ${agent}`)) {
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
    return this.activeLoopCards.size > 0 || this.cardInStatus(HARNESS_STATUSES);
  }

  private cardInStatus(statuses: CardStatus[], repoId?: string): boolean {
    return (
      db
        .select({ id: cards.id })
        .from(cards)
        .where(and(inArray(cards.status, statuses), repoId ? eq(cards.repoId, repoId) : undefined))
        .limit(1)
        .get() !== undefined
    );
  }

  /** How many of `repoId`'s cards are actively running a harness. Queued or
   * human-waiting cards do not count, and repos never share slots.
   *
   * Counted over distinct card ids: a loop appears in `activeLoopCards` from
   * before its card reaches `looping` until after it leaves, so the two
   * sources overlap for most of a run. */
  private pipelineLoad(repoId: string): number {
    const running = new Set(
      db
        .select({ id: cards.id })
        .from(cards)
        .where(and(inArray(cards.status, HARNESS_STATUSES), eq(cards.repoId, repoId)))
        .all()
        .map((c) => c.id),
    );
    for (const [cardId, id] of this.activeLoopCards) if (id === repoId) running.add(cardId);
    return running.size;
  }

  /**
   * Cards this repo may run at once (spec 20). The operator's setting, except
   * on a local loop provider: `omlx` owns the machine's unified memory, which
   * is the actual reason locked decision 5 gave for a serial queue, so that
   * queue stays serial however the setting reads. Ignored rather than
   * rejected, because the provider can change under a saved setting.
   */
  private concurrencyLimit(): number {
    const settings = getSettings();
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
    if (this.draining) return;

    // Read once, then filter per repo — preserving the tie-break order
    // (ready before todo, oldest startedAt/position first) within each repo.
    const readyCards = db
      .select()
      .from(cards)
      .where(eq(cards.status, "ready"))
      .orderBy(asc(cards.startedAt))
      .all();
    const todoCards = db
      .select()
      .from(cards)
      .where(eq(cards.status, "todo"))
      .orderBy(asc(cards.position))
      .all();
    const autoMode = getSettings().autoMode;
    const eligibleTodoRepoIds = planningCandidates(todoCards, autoMode).map((c) => c.repoId);
    const repoIds = [...new Set([...readyCards.map((c) => c.repoId), ...eligibleTodoRepoIds])];

    for (const repoId of repoIds) {
      const repoReady = readyCards.filter((c) => c.repoId === repoId);
      /** Todo cards already handed to startCard in this pass. A planned card
       * that has a plan goes back to Ready rather than consuming a slot, and
       * startCard pumps again, so without this the loop would re-pick it from
       * the stale list forever. */
      const planned = new Set<string>();
      let nextReady = 0;
      // Spec 20: fill every free slot this repo has rather than one card per
      // pump. pipelineLoad is re-read each pass, so a card started by a
      // nested pump() is counted before the next start decision.
      while (!this.pipelineBusy(repoId)) {
        const readyCard = repoReady[nextReady++];
        if (readyCard) {
          // A nested pump may have claimed it since the list was read.
          if (this.getCard(readyCard.id)?.status !== "ready") continue;
          const id = readyCard.id;
          this.activeLoopCards.set(id, repoId);
          void this.runLoop(id)
            .catch((err) => {
              if (this.getCard(id)?.status === "looping") {
                this.moveCard(id, "looping", "needs_attention", String(err));
              }
            })
            .finally(() => {
              this.activeLoopCards.delete(id);
              this.pump();
            });
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
  }

  private async runLoop(cardId: string) {
    const card = this.getCard(cardId)!;
    const repo = db.select().from(repos).where(eq(repos.id, card.repoId)).get();
    if (!repo) throw new Error("repo not found");
    const plan = this.latestPlan(cardId);
    if (!plan) throw new Error("card has no plan");
    const settings = getSettings();
    const maxIterations = card.maxIterations ?? settings.defaultMaxIterations;
    const timeoutMs = (card.timeoutMinutes ?? settings.defaultTimeoutMinutes) * 60 * 1000;
    const provider = normalizeProvider(settings.loopProvider, "anthropic");
    const loopModel = card.loopModel || settings.loopModel;

    const runId = nanoid();
    const { worktreePath, branch, baseBranch, created } = await resolveWorktree(
      repo, card, runId, this.latestWorktreeRun(cardId),
    );
    // Ensure the worktree carries the current plan's artifacts.
    const ralphDir = path.join(/* turbopackIgnore: true */ worktreePath, ".ralph");
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
      fs.writeFileSync(
        /* turbopackIgnore: true */ planPath,
        fs.existsSync(/* turbopackIgnore: true */ legacyPlanPath)
          ? fs.readFileSync(/* turbopackIgnore: true */ legacyPlanPath, "utf8")
          : plan.planMd,
      );
    }
    // CRITERIA.md is orchestrator-private like PLAN.md (the evaluator gets the
    // criteria injected into its prompt). Only PROMPT.md and the signal files
    // may remain in the worktree.
    for (const name of ["PLAN.md", "CRITERIA.md", "DONE", "DONE.md"]) {
      fs.rmSync(/* turbopackIgnore: true */ ralphFile(name), { force: true });
    }
    fs.writeFileSync(/* turbopackIgnore: true */ ralphFile("PROMPT.md"), plan.promptMd);
    clearEvaluationArtifact(ralphDir);
    // A reused worktree (retry, restart) may have been left on another branch
    // by an earlier run's agent. Commit nothing to it; the run fails below,
    // once it has a row to fail.
    const offBranchAtStart = await offRunBranchReason(worktreePath, branch);
    if (!offBranchAtStart) {
      await tryGit(worktreePath, "add", ".ralph");
      await tryGit(worktreePath, "commit", "-m", `ralph: sync plan v${plan.version}`);
    }

    // Spec 14 L3: per-run sandbox context and the parent-repo integrity
    // baseline. The baseline persists to disk because the pre-merge re-check
    // may run long after this process is gone.
    const ctx = createRunSandbox(runId, { cwd: worktreePath, s: settings });
    // Multi-GB allocation — skipped under test, fire-and-forget otherwise.
    if (process.env.NODE_ENV !== "test") void ensureBallast(this.ballastPath());
    const integrityBaseline = await snapshotRepoIntegrity(repo.path);
    if (integrityBaseline) {
      saveBaseline(runId, integrityBaseline);
      // Spec 20: with more than one card in flight, another card's approved
      // merge moves this run's base branch. Registering lets that merge record
      // its own write here instead of this run reporting it as tampering.
      registerRunBaseline(runId, repo.path, integrityBaseline);
    }

    startRunRow(
      { id: runId, cardId, planId: plan.id, kind: "loop", worktreePath, branch, baseBranch, provider, model: loopModel },
      ctx,
      settings,
      created ? repo.id : undefined,
    );
    // The awaited git calls above open a window where the user can cancel
    // before this run row existed — the CAS failing means the card left the
    // queue, so never start the loop for it.
    if (!this.moveCard(cardId, card.status, "looping")) {
      this.finishRun(runId, "cancelled", "card left the queue before the loop started");
      await ctx.cleanup();
      return;
    }
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
    const fail = (reason: string, n?: number, status: FinishStatus = "failed") => {
      this.finishRun(runId, status, reason, n);
      this.moveCard(cardId, "looping", "needs_attention", reason);
    };

    // Disk watchdog (spec 14 L3): a trip finalizes the run itself, then aborts
    // the harness — the abort-guard below treats that like a cancellation.
    const watchdog = startDiskWatchdog({
      paths: [worktreePath, ctx.root],
      ballastPath: this.ballastPath(),
      onTrip: (reason) => {
        if (this.finishRun(runId, "failed", reason)) {
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
        return fail(`loop provider unreachable: ${e instanceof Error ? e.message : String(e)}`);
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
          return fail(`failed to resolve oMLX model: ${e instanceof Error ? e.message : String(e)}`);
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
      let n = 0;

      while (n < maxIterations) {
        const remaining = deadline - Date.now();
        if (remaining < 30_000) return fail("timeout", n, "timeout");
        // Every iteration needs an unchecked task to inject — there is no
        // fallback prompt. An exhausted checklist here means the final task
        // ended without a DONE signal (e.g. its criteria failed).
        const planMd = fs.readFileSync(/* turbopackIgnore: true */ planPath, "utf8");
        const task = firstUnchecked(planMd);
        // Nothing to inject means the final task was ticked without its DONE.
        // This ending belongs to the planner (`pendingReplanFeedback` turns it
        // into a re-plan on top of the branch), not to a retry of the loop.
        if (!task) return fail(CHECKLIST_EXHAUSTED_EXIT, n);
        n += 1;
        const transcriptFile = `iter-${String(n).padStart(3, "0")}.jsonl`;
        const iter = db
          .insert(iterations)
          .values({
            runId,
            n,
            transcriptPath: path.join(runTranscriptDir(runId), transcriptFile),
            taskNumber: task.taskNumber,
            taskCount: parseChecklist(planMd)?.items.length ?? task.taskNumber,
            taskText: task.item.text,
            startedAt: now(),
          })
          .returning()
          .get();
        emitEvent("iteration.started", { cardId, runId, payload: { n, maxIterations } });

        const before = await buildProgressState(worktreePath, planPath);
        const preIteration = await captureIterationState(worktreePath);
        // Install-script gate trigger (spec 14): a changed lockfile
        // fingerprint after the iteration means an install happened.
        const lockfilesBefore = lockfileFingerprint(worktreePath);
        const promptMd = fs.readFileSync(/* turbopackIgnore: true */ ralphFile("PROMPT.md"), "utf8");
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
            prompt: buildLoopPrompt(promptMd, planMd) + (remindSignal ? SIGNAL_REMINDER : ""),
            cwd: worktreePath,
            timeoutMs: Math.min(remaining, budgetMs),
            signal: controller.signal,
            role: "loop",
            runContext: ctx,
          });
        } finally {
          clearTimeout(slowTimer);
        }

        if (controller.signal.aborted) return; // cancelCard already finalized

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
        const offBranch = await offRunBranchReason(worktreePath, branch);
        if (offBranch) return fail(offBranch, n);

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
        if (!task.isLastUnchecked) {
          for (const name of ["DONE", "DONE.md"]) {
            fs.rmSync(/* turbopackIgnore: true */ ralphFile(name), { force: true });
          }
        }

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
          for (const name of ["BLOCKED", "ITERATION_DONE", "DONE", "DONE.md"]) {
            fs.rmSync(/* turbopackIgnore: true */ ralphFile(name), { force: true });
          }
          db.update(runs).set({ feedback: blocker }).where(eq(runs.id, runId)).run();
          addScopingMessage(cardId, "loop", blocker);
          emitEvent("loop.blocked", {
            cardId,
            runId,
            payload: { n, taskNumber: task.taskNumber, blocker: blocker.slice(0, 500) },
          });
          return fail(LOOP_BLOCKED_EXIT, n);
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
          if (violation) return fail(violation, n);
          if (await this.checkInstallGate({ cardId, runId, repoId: repo.id, worktreePath, n })) return;

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
              for (const name of ["DONE", "DONE.md"]) {
                fs.rmSync(/* turbopackIgnore: true */ ralphFile(name), { force: true });
              }
              // Every iteration runs on an injected checklist task, so the
              // repair has to be one — a prompt preamble alone never runs.
              fs.writeFileSync(
                /* turbopackIgnore: true */ planPath,
                appendTask(fs.readFileSync(/* turbopackIgnore: true */ planPath, "utf8"), repairTaskText(failures)),
              );
              continue;
            }
          }
          this.finishRun(runId, "completed", "done-signal", n);
          // Phase 3: every DONE goes through the evaluator before a human
          // sees it. An evaluator crash is a loud failure, not a pass-through.
          this.moveCard(cardId, "looping", "evaluating");
          this.startStage("evaluating", cardId);
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
          if (remaining <= budgetMs) return fail("timeout", n, "timeout");
          // Per-iteration hard timeout: one retry with the worktree
          // preserved; a second timeout anywhere in the run ends it (spec 11,
          // amended by spec 18 §2).
          iterationTimeouts += 1;
          emitEvent("iteration.timeout", {
            cardId,
            runId,
            payload: { n, hardTimeoutMs, budgetMs, timeoutsThisRun: iterationTimeouts },
          });
          if (iterationTimeouts >= 2) return fail("iteration-timeout", n, "timeout");
          continue;
        }
        if (failed) {
          consecutiveFailures += 1;
          // A first-iteration connection/auth failure means the provider is
          // down or misconfigured — no point retrying.
          // A limit error means the allowance is gone, not that this
          // iteration was unlucky. Stop the run on the first one rather than
          // spending the remaining failure budget re-hitting the same wall.
          const failureKind = classifyProviderError(result.error);
          // A "config" failure says nothing about the provider's health — it
          // is serving fine and rejecting this request (spec 18 §3), so it
          // must not count towards the breaker.
          if (failureKind && failureKind !== "config") {
            recordProviderOutcome(provider, false, {
              kind: failureKind,
              retryAfterMs: failureKind === "limit" ? limitCooldownMs(provider, result.error) : null,
            });
          }
          const isConnErr = failureKind === "conn";
          const isLimitErr = failureKind === "limit";
          // A rejected request is rejected the same way every time. Spending
          // the remaining failure budget rediscovering that is pure waste.
          const isConfigErr = failureKind === "config";
          if (consecutiveFailures >= 3 || isLimitErr || isConfigErr || (n === 1 && isConnErr)) {
            return fail(`loop failed: ${result.error.slice(0, 300)}`, n);
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
          return fail("loop ended two iterations without writing .ralph/ITERATION_DONE", n);
        }
        recordTaskCompleted(iter.id, planPath, task.taskNumber);

        // Install-script gate (spec 14): fire on any lockfile change, after
        // bookkeeping so a resumed run starts its next iteration cleanly.
        if (
          lockfileFingerprint(worktreePath) !== lockfilesBefore &&
          (await this.checkInstallGate({ cardId, runId, repoId: repo.id, worktreePath, n }))
        ) {
          return;
        }

        if ((await buildProgressState(worktreePath, planPath)) === before) {
          consecutiveStalls += 1;
          if (consecutiveStalls >= 3) return fail("stalled", n);
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
            return fail(`prompt grew to ${Math.round(bloat)}x the run's median for two iterations`, n);
          }
        } else {
          consecutiveBloat = 0;
        }
        if (result.promptTokens) promptTokensSeen.push(result.promptTokens);

        if (this.pausedCards.has(cardId)) {
          // Not "completed" (spec 18 §6): the operator stopped this run, it
          // did not achieve anything. Scoring it as a success put a run that
          // spent 51.6 minutes on one unfinished task in the numerator of the
          // success rate.
          this.finishRun(runId, "paused", "paused by user", n);
          this.moveCard(cardId, "looping", "paused", "paused by user");
          return;
        }

        // Shutdown reached us between iterations: everything up to here is
        // committed and ticked, so stop on the boundary and hand the card
        // back to Ready. recover() resumes it on the next boot, having lost
        // nothing. A drain that runs out of time mid-iteration still exits
        // hard, and that path costs the one iteration.
        if (this.draining) {
          this.finishRun(runId, "interrupted", "stopped for restart", n);
          this.moveCard(cardId, "looping", "ready", "stopped for restart");
          return;
        }
      }
      fail("max-iterations", n);
    } finally {
      watchdog.stop();
      this.controllers.delete(runId);
      releaseRunBaseline(runId);
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
    n: number;
  }): Promise<boolean> {
    const repo = db.select().from(repos).where(eq(repos.id, opts.repoId)).get();
    if (!repo) return false;
    const unapproved = unapprovedScripts(collectLifecycleScripts(opts.worktreePath), approvedScripts(repo));
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
    this.finishRun(opts.runId, "completed", "install-script gate", opts.n);
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
    const card = this.requireCard(cardId);
    if (card.status !== "needs_attention") {
      throw new ClientError(`cannot approve install scripts for a ${card.status} card`);
    }
    if (packages.length === 0) throw new ClientError("no packages to approve");
    const run = this.latestWorktreeRun(cardId);
    if (!run) throw new ClientError("card has no worktree left to resume");
    const repo = db.select().from(repos).where(eq(repos.id, card.repoId)).get();
    if (!repo) throw new ClientError("repo not found", 404);

    // Approve only what is actually present in the resolved tree, matched on
    // the full {name, version, scriptHash} triple — a stale UI payload must
    // not approve a script body the human never saw.
    const requested = new Set(packages.map(scriptKey));
    const present = collectLifecycleScripts(run.worktreePath).filter((p) => requested.has(scriptKey(p)));
    if (present.length === 0) {
      throw new ClientError(
        "none of the requested packages match the worktree's resolved tree — re-open the card to see the current gate state",
      );
    }

    const rebuild = await rebuildPackages(run.worktreePath, [...new Set(present.map((p) => p.name))]);
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
      payload: { packages: present.map((p) => `${p.name}@${p.version}`) },
    });

    // Resume in place. A checklist with no unchecked task means the gate
    // fired on the DONE path — evaluation is next, not another loop run.
    const planPath = planStatePath(cardId);
    const planMd = fs.existsSync(/* turbopackIgnore: true */ planPath)
      ? fs.readFileSync(/* turbopackIgnore: true */ planPath, "utf8")
      : "";
    if (planMd && !firstUnchecked(planMd)) {
      if (this.moveCard(cardId, "needs_attention", "evaluating", "install scripts approved")) {
        this.startStage("evaluating", cardId);
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

  retryMerge(cardId: string) {
    return this.reviewService.retryMerge(cardId);
  }

  reject(runId: string, feedback: string) {
    return this.reviewService.reject(runId, feedback);
  }

  abandon(cardId: string) {
    return this.reviewService.abandon(cardId);
  }

  async resetCard(cardId: string) {
    const card = this.requireCard(cardId);
    const repo = db.select().from(repos).where(eq(repos.id, card.repoId)).get()!;
    this.cancelActiveRun(cardId, "reset by user");

    // Remove worktrees for ALL runs before deleting their rows.
    const allRuns = db.select().from(runs).where(eq(runs.cardId, cardId)).all();
    for (const run of allRuns) {
      if (fs.existsSync(/* turbopackIgnore: true */ run.worktreePath)) {
        await removeWorktree(repo.path, run.worktreePath, run.branch);
      }
      removeBaseline(run.id);
    }
    removeRunTranscripts(allRuns.map((run) => run.id));

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
  return (g.__radulfOrchestrator ??= new Orchestrator());
}
