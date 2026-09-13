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
  type CardStatus,
} from "@/db";
import { emitEvent } from "./events";
import { getSettings } from "./settings";
import { startTranscriptPush } from "./transcript";
import {
  buildLoopPrompt,
  buildProgressState,
  captureIterationState,
  performIterationBookkeeping,
  performDoneBookkeeping,
  planStatePath,
} from "./bookkeeping";
import { firstUnchecked, parseChecklist } from "./checklist";
import { SLOW_ITERATION_MS } from "./analytics";
import { runHarness, type RunTelemetry } from "./harness";
import {
  listProviderModels,
  normalizeProvider,
  preflightProvider,
} from "./providers";
import { CONN_ERROR_PATTERN, isProviderOpen, recordProviderOutcome } from "./circuitBreaker";
import {
  createWorktree,
  recordWorktree,
  removeWorktree,
  tryGit,
  currentBranch,
} from "./git";
import { removeRunTranscripts, runTranscriptDir } from "./retention";
import { PlanningService, pendingRejectionFeedback } from "./planningService";
import { EvaluationService, clearEvaluationArtifact } from "./evaluationService";
import { ReviewService } from "./reviewService";
import { ClientError } from "./clientError";
import { retryableFailedStep } from "@/shared/failedStep";
import { createRunSandbox, runScratchRoot } from "./sandbox/context";
import { ensureBallast, startDiskWatchdog } from "./sandbox/diskWatchdog";
import { initializeSandboxRuntimeOnce } from "./sandbox/srt";
import {
  checkRepoIntegrity,
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
import type { ApprovedInstallScript } from "@/db";

type Card = typeof cards.$inferSelect;
type Run = typeof runs.$inferSelect;

/** Small models write DONE.md as often as DONE — accept both. */
export function doneFilePath(ralphDir: string): string | null {
  for (const name of ["DONE", "DONE.md"]) {
    const p = path.join(/* turbopackIgnore: true */ ralphDir, name);
    if (fs.existsSync(/* turbopackIgnore: true */ p)) return p;
  }
  return null;
}

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
   * background. A Map (not just a Set of card IDs) so pipelineBusy(repoId)
   * can answer "is repo X busy" without an extra DB round-trip per call. */
  private activeLoopCards = new Map<string, string>();
  /** Card IDs that have requested a pause on next iteration boundary. */
  private pausedCards = new Set<string>();
  /** Set by startDraining() during graceful shutdown — pump() stops starting
   * new runs but any run already in flight keeps going until it finishes. */
  private draining = false;
  /** runId → controller for every live child process (plan or loop). */
  private controllers = new Map<string, AbortController>();
  private planningService = new PlanningService({
    getCard: (cardId) => this.getCard(cardId),
    latestPlan: (cardId) => this.latestPlan(cardId),
    latestWorktreeRun: (cardId) => this.latestWorktreeRun(cardId),
    moveCard: (cardId, from, to, reason) => this.moveCard(cardId, from, to, reason),
    finishRun: (runId, status, exitReason, telemetry) =>
      this.finishRun(runId, status, exitReason, undefined, telemetry),
    registerController: (runId, controller) => this.controllers.set(runId, controller),
    releaseController: (runId) => this.controllers.delete(runId),
    pump: () => this.pump(),
  });
  private evaluationService = new EvaluationService({
    getCard: (cardId) => this.getCard(cardId),
    latestPlan: (cardId) => this.latestPlan(cardId),
    latestWorktreeRun: (cardId) => this.latestWorktreeRun(cardId),
    moveCard: (cardId, from, to, reason) => this.moveCard(cardId, from, to, reason),
    finishRun: (runId, status, exitReason, telemetry) =>
      this.finishRun(runId, status, exitReason, undefined, telemetry),
    registerController: (runId, controller) => this.controllers.set(runId, controller),
    releaseController: (runId) => this.controllers.delete(runId),
    pump: () => this.pump(),
    // "auto": the evaluator released this diff, not a human. Spec 15 makes a
    // pull request delivered this way a draft.
    approveReview: (runId) => this.reviewService.approve(runId, "auto"),
  });
  private reviewService = new ReviewService({
    getCard: (cardId) => this.getCard(cardId),
    latestPlan: (cardId) => this.latestPlan(cardId),
    latestWorktreeRun: (cardId) => this.latestWorktreeRun(cardId),
    moveCard: (cardId, from, to, reason) => this.moveCard(cardId, from, to, reason),
    pump: () => this.pump(),
  });

  constructor(options: { autoStart?: boolean } = {}) {
    if (options.autoStart !== false) {
      this.recover();
      this.pump();
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
      db.update(iterations)
        .set({ status: "failed", summary: "interrupted by server restart", endedAt: now() })
        .where(eq(iterations.runId, run.id))
        .run();
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
    // reviewing card lost the in-process merge claim. All need a human.
    const orphans = db
      .select()
      .from(cards)
      .where(inArray(cards.status, ["planning", "looping", "evaluating", "reviewing"]))
      .all();
    for (const card of orphans) {
      this.moveCard(card.id, card.status, "needs_attention", "interrupted");
    }
  }

  // ---- helpers -------------------------------------------------------------

  private getCard(cardId: string): Card | undefined {
    return db.select().from(cards).where(eq(cards.id, cardId)).get();
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

  /** Mark a run finished — only if it is still `running` (guards cancel races). */
  private finishRun(
    runId: string,
    status: "completed" | "failed" | "timeout" | "cancelled",
    exitReason: string,
    iterationsDone?: number,
    telemetry?: RunTelemetry,
  ): boolean {
    const run = db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!run || run.status !== "running") return false;
    // A pause request only applies to the live loop — a run that ends for any
    // other reason (cancel, DONE, timeout) must not pause the card's next run.
    this.pausedCards.delete(run.cardId);
    // Plan/evaluate pass their single runHarness invocation's telemetry
    // explicitly; a loop run has none passed (its telemetry lives per
    // iteration), so roll it up from the iterations just recorded.
    const rollup = telemetry ?? (run.kind === "loop" ? this.loopTelemetryRollup(runId) : undefined);
    db.update(runs)
      .set({
        status,
        exitReason,
        endedAt: now(),
        ...(iterationsDone !== undefined ? { iterationsDone } : {}),
        ...(rollup ?? {}),
      })
      .where(eq(runs.id, runId))
      .run();
    emitEvent("run.finished", {
      cardId: run.cardId,
      runId,
      payload: { status, exitReason },
    });
    return true;
  }

  /** Run-level telemetry roll-up for a loop run: sum its iterations, mirroring
   * the "null means unreported" convention — a field is null only when NO
   * iteration reported it, so a partial sample still sums the facts it has. */
  private loopTelemetryRollup(runId: string): RunTelemetry {
    const rows = db
      .select()
      .from(iterations)
      .where(eq(iterations.runId, runId))
      .orderBy(asc(iterations.n))
      .all();
    const sum = (values: (number | null)[]): number | null => {
      const present = values.filter((v): v is number => v != null);
      return present.length > 0 ? present.reduce((s, v) => s + v, 0) : null;
    };
    return {
      promptTokens: sum(rows.map((r) => r.promptTokens)),
      completionTokens: sum(rows.map((r) => r.completionTokens)),
      cachedInputTokens: sum(rows.map((r) => r.cachedInputTokens)),
      cacheWriteTokens: sum(rows.map((r) => r.cacheWriteTokens)),
      reasoningTokens: sum(rows.map((r) => r.reasoningTokens)),
      modelTurns: sum(rows.map((r) => r.modelTurns)),
      toolCalls: sum(rows.map((r) => r.toolCalls)),
      toolDurationMs: sum(rows.map((r) => r.toolDurationMs)),
      // Time to first token describes the run's start, not a sum — the first
      // iteration's value.
      firstTokenMs: rows[0]?.firstTokenMs ?? null,
      costUsd: sum(rows.map((r) => r.costUsd)),
      harness: rows[0]?.harness ?? null,
      harnessVersion: rows[0]?.harnessVersion ?? null,
    };
  }

  /** External awaits may finish after a user cancellation. Never let their
   * continuation mutate a run/card that is no longer the live loop. */
  private isRunActive(runId: string, cardId: string, signal: AbortSignal): boolean {
    if (signal.aborted) return false;
    const run = db.select().from(runs).where(eq(runs.id, runId)).get();
    const card = this.getCard(cardId);
    return run?.status === "running" && card?.status === "looping";
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

  // ---- entry points --------------------------------------------------------

  /** Todo → In Progress. Plans if needed, otherwise queues for the loop slot. */
  startCard(cardId: string) {
    const card = this.getCard(cardId);
    if (!card) throw new ClientError("card not found", 404);
    if (!["todo", "needs_attention"].includes(card.status))
      throw new ClientError(`cannot start card in status ${card.status}`);
    if (!card.startedAt)
      db.update(cards).set({ startedAt: now() }).where(eq(cards.id, cardId)).run();

    if (this.latestPlan(cardId) && !pendingRejectionFeedback(cardId)) {
      // Restart path — plan exists, go straight to the loop queue. A card
      // whose diff was rejected falls through: rejections re-plan first.
      this.moveCard(cardId, card.status, "ready");
      this.pump();
    } else if (this.pipelineBusy(card.repoId)) {
      // One ticket runs at a time. The startedAt set above marks this a manual
      // start; land it back in todo so pump picks it up (oldest manual start
      // first) when the pipeline frees. pump only scans todo for planning, so
      // a restarted needs_attention card must return there or it would never
      // be picked up.
      if (card.status !== "todo") {
        this.moveCard(cardId, card.status, "todo", "queued for planning");
      }
    } else {
      this.moveCard(cardId, card.status, "planning");
      void this.planningService.runPlanning(cardId).catch((err) => {
        if (this.getCard(cardId)?.status === "planning") {
          this.moveCard(cardId, "planning", "needs_attention", String(err));
        }
      });
    }
  }

  /** Backlog → Todo. Auto-mode may immediately claim the queued card. */
  queueCard(cardId: string) {
    const card = this.getCard(cardId);
    if (!card) throw new ClientError("card not found", 404);
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
        .set({
          status: "todo",
          position: maxPosition + 1,
          startedAt: null,
          updatedAt: now(),
        })
        .where(and(eq(cards.id, cardId), eq(cards.status, "backlog")))
        .run();
    });
    if (result.changes !== 1) {
      throw new ClientError("card status changed before it could be queued");
    }
    emitEvent("card.moved", {
      cardId,
      payload: { from: "backlog", to: "todo", reason: "queued" },
    });
    this.pump();
  }

  pauseCard(cardId: string) {
    const card = this.getCard(cardId);
    if (!card) throw new ClientError("card not found", 404);
    if (card.status !== "looping")
      throw new ClientError(`cannot pause a ${card.status} card`);
    this.pausedCards.add(cardId);
  }

  resumeCard(cardId: string) {
    const card = this.getCard(cardId);
    if (!card) throw new ClientError("card not found", 404);
    if (card.status !== "paused")
      throw new ClientError(`cannot resume a ${card.status} card`);
    this.pausedCards.delete(cardId);
    this.moveCard(cardId, "paused", "ready");
    this.pump();
  }

  cancelCard(cardId: string) {
    const card = this.getCard(cardId);
    if (!card) throw new ClientError("card not found", 404);
    const active = db
      .select()
      .from(runs)
      .where(and(eq(runs.cardId, cardId), eq(runs.status, "running")))
      .orderBy(desc(runs.startedAt))
      .limit(1)
      .get();
    if (active) {
      this.finishRun(active.id, "cancelled", "cancelled by user");
      db.update(iterations)
        .set({ status: "failed", summary: "cancelled by user", endedAt: now() })
        .where(eq(iterations.runId, active.id))
        .run();
      this.controllers.get(active.id)?.abort();
    }
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
    const card = this.getCard(cardId);
    if (!card) throw new ClientError("card not found", 404);
    if (card.status !== "needs_attention")
      throw new ClientError(`cannot restart card in status ${card.status}`);
    this.startCard(cardId);
  }

  /** Retry the latest failed pipeline stage without replaying completed ones. */
  retryFailedStep(cardId: string): { ok: true; step: NonNullable<ReturnType<typeof retryableFailedStep>> } {
    const card = this.getCard(cardId);
    if (!card) throw new ClientError("card not found", 404);
    const cardRuns = db.select().from(runs).where(eq(runs.cardId, cardId)).all();
    const step = retryableFailedStep(cardRuns);
    if (!step) throw new ClientError("the latest pipeline step did not fail");

    if (card.status !== "needs_attention") {
      throw new ClientError(`cannot retry ${step} for card in status ${card.status}`);
    }

    if (step === "plan") {
      if (this.pipelineBusy(card.repoId)) throw new ClientError("another task is already being worked on");
      if (!this.moveCard(cardId, "needs_attention", "planning", "retrying failed planner")) {
        throw new ClientError("card status changed before the planner could retry");
      }
      void this.planningService.runPlanning(cardId).catch((error) => {
        if (this.getCard(cardId)?.status === "planning") {
          this.moveCard(cardId, "planning", "needs_attention", String(error));
        }
      });
      return { ok: true, step };
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

    // step === "evaluate"
    if (!this.moveCard(cardId, "needs_attention", "evaluating", "retrying failed evaluator")) {
      throw new ClientError("card status changed before the evaluator could retry");
    }
    void this.evaluationService.runEvaluator(cardId).catch((error) => {
      if (this.getCard(cardId)?.status === "evaluating") {
        this.moveCard(cardId, "evaluating", "needs_attention", String(error));
      }
    });
    return { ok: true, step };
  }

  // ---- pipeline pump -------------------------------------------------------

  /** Stop pump() from starting new runs. Called once, on shutdown signal —
   * any run already in flight keeps going until it finishes or the caller's
   * own timeout gives up on waiting (see instrumentation.ts). */
  startDraining() {
    this.draining = true;
  }

  /** True while any repo has a run in flight (planning, looping, or
   * evaluating) — used by graceful shutdown to know whether it's safe to
   * exit immediately. Deliberately global, unlike pipelineBusy(repoId):
   * shutdown drains the whole process, not one repo. */
  hasInFlightWork(): boolean {
    if (this.activeLoopCards.size > 0) return true;
    return (
      db
        .select({ id: cards.id })
        .from(cards)
        .where(inArray(cards.status, ["planning", "looping", "evaluating"]))
        .limit(1)
        .get() !== undefined
    );
  }

  /** True while a card in `repoId` is actively running a harness (planning,
   * looping, or evaluating) — that repo's single pipeline slot is occupied.
   * Cards queued (todo, ready) or waiting on a human (plan_review, paused,
   * needs_attention) do not count. Repos never share a slot, so this is
   * always scoped to one repoId, never global. */
  private pipelineBusy(repoId: string): boolean {
    for (const activeRepoId of this.activeLoopCards.values()) {
      if (activeRepoId === repoId) return true;
    }
    return (
      db
        .select({ id: cards.id })
        .from(cards)
        .where(and(eq(cards.repoId, repoId), inArray(cards.status, ["planning", "looping", "evaluating"])))
        .limit(1)
        .get() !== undefined
    );
  }

  /** Advance every repo's queue independently. Each repo gets its own single
   * pipeline slot: one card per repo runs at a time — a ready card loops
   * before any new card in that repo is planned, and nothing new starts in a
   * repo while a card there is planning, looping, or evaluating. Unrelated
   * repos never wait on each other. */
  pump() {
    if (this.draining) return;

    // Finish in-flight tickets first: a planned (ready) card loops before any
    // fresh Todo card in the same repo is planned. Both queries are read once
    // up front and then filtered per repo below, preserving the existing
    // tie-break order (ready before todo, oldest startedAt/position first)
    // within each repo.
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
      if (this.pipelineBusy(repoId)) continue;

      const readyCard = readyCards.find((c) => c.repoId === repoId);
      if (readyCard) {
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

      // Otherwise plan the next eligible Todo card in this repo: explicit
      // manual starts (startedAt set, oldest first) first, then the queue in
      // position order when auto-mode is on. Backlog is never queried here.
      const next = planningCandidates(
        todoCards.filter((c) => c.repoId === repoId),
        autoMode,
      )[0];
      if (!next) continue;
      try {
        this.startCard(next.cardId);
      } catch {
        // startCard throws on bad state — silently skip.
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
    const loopProvider = normalizeProvider(settings.loopProvider, "anthropic");
    const loopModel = card.loopModel || settings.loopModel;

    const runId = nanoid();
    // Reuse the card's existing worktree (reject/restart) or make a fresh one.
    const prev = this.latestWorktreeRun(cardId);
    const baseBranch =
      prev?.baseBranch ?? card.baseBranch ?? (await currentBranch(repo.path, repo.defaultBranch));
    let worktreePath: string;
    let branch: string;
    if (prev) {
      ({ worktreePath, branch } = prev);
    } else {
      ({ worktreePath, branch } = await createWorktree(repo.path, baseBranch, card.title, runId));
    }
    // Ensure the worktree carries the current plan's artifacts.
    const ralphDir = path.join(/* turbopackIgnore: true */ worktreePath, ".ralph");
    fs.mkdirSync(/* turbopackIgnore: true */ ralphDir, { recursive: true });
    // The private PLAN.md holds the task checklist the orchestrator ticks off —
    // its checked state is the loop's memory, so never clobber an existing
    // copy on restart. Adopt a legacy in-worktree copy (pre-private-plan
    // cards) so its ticks survive, then remove it: the loop agent must never
    // be able to read PLAN.md.
    const planPath = planStatePath(cardId);
    const legacyPlanPath = path.join(/* turbopackIgnore: true */ ralphDir, "PLAN.md");
    if (!fs.existsSync(/* turbopackIgnore: true */ planPath)) {
      fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(planPath), { recursive: true });
      fs.writeFileSync(
        /* turbopackIgnore: true */ planPath,
        fs.existsSync(/* turbopackIgnore: true */ legacyPlanPath)
          ? fs.readFileSync(/* turbopackIgnore: true */ legacyPlanPath, "utf8")
          : plan.planMd,
      );
    }
    fs.rmSync(/* turbopackIgnore: true */ legacyPlanPath, { force: true });
    // CRITERIA.md is orchestrator-private like PLAN.md: the loop must never see
    // the whole-card acceptance criteria (the evaluator gets them injected into
    // its prompt from plan.acceptanceCriteria). Drop any planner-authored copy
    // from the worktree so only PROMPT.md and the signal files remain.
    fs.rmSync(path.join(/* turbopackIgnore: true */ ralphDir, "CRITERIA.md"), { force: true });
    fs.writeFileSync(
      path.join(/* turbopackIgnore: true */ ralphDir, "PROMPT.md"),
      plan.promptMd,
    );
    fs.rmSync(path.join(/* turbopackIgnore: true */ ralphDir, "DONE"), { force: true });
    fs.rmSync(path.join(/* turbopackIgnore: true */ ralphDir, "DONE.md"), { force: true });
    clearEvaluationArtifact(ralphDir);
    await tryGit(worktreePath, "add", ".ralph");
    await tryGit(worktreePath, "commit", "-m", `ralph: sync plan v${plan.version}`);

    // Spec 14 L3: per-run sandbox context (private TMPDIR + caches, allowlist
    // env, ulimit/pgid preamble) and the parent-repo integrity baseline. The
    // baseline persists to disk because the pre-merge re-check may run long
    // after this process is gone.
    const ctx = createRunSandbox(runId, { cwd: worktreePath, s: settings });
    // Multi-GB allocation — skipped under test, fire-and-forget otherwise.
    if (process.env.NODE_ENV !== "test") void ensureBallast(this.ballastPath());
    const integrityBaseline = await snapshotRepoIntegrity(repo.path);
    if (integrityBaseline) saveBaseline(runId, integrityBaseline);

    db.insert(runs)
      .values({
        id: runId,
        cardId,
        planId: plan.id,
        kind: "loop",
        worktreePath,
        branch,
        baseBranch,
        provider: loopProvider,
        model: loopModel,
        startedAt: now(),
        diskLimitMechanism: ctx.diskLimitMechanism,
        sandboxed: settings.sandboxEnabled ? 1 : 0,
      })
      .run();
    // events.run_id is a real FK too — emit only now that the run row exists
    // (PLAN.md Phase 18.1: createRunSandbox used to emit this itself, before
    // this insert, and crashed run start whenever the flag was on).
    if (ctx.weakerIsolationEnabled) {
      emitEvent("sandbox.weaker_isolation_enabled", {
        cardId,
        runId,
        payload: { reason: "sandboxWeakerIsolationForGoTls" },
      });
    }
    // worktrees.runId is a real FK — record the worktree only now that its
    // owning run row exists (creating it earlier would violate the constraint).
    if (!prev) recordWorktree(repo.id, runId, worktreePath, branch);
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

    // Disk watchdog (spec 14 L3): the default disk bound on macOS and the
    // cross-platform backstop beside the Linux cgroup. A trip finalizes the
    // run itself, then aborts the harness — the abort-guard below treats an
    // already-finalized run like a cancellation.
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
      // Circuit breaker: a provider that has recently shown connection/auth
      // failures fails this run fast instead of repeating the same slow
      // preflight-then-iterate failure.
      if (isProviderOpen(loopProvider)) {
        const reason = `provider ${loopProvider} circuit breaker open — recent connection failures, will retry automatically after cooldown`;
        this.finishRun(runId, "failed", reason);
        this.moveCard(cardId, "looping", "needs_attention", reason);
        return;
      }

      // Fail fast if the loop provider is down or not serving the model, rather
      // than spending iterations discovering it mid-run.
      try {
        await preflightProvider(loopProvider, loopModel, settings);
        if (!this.isRunActive(runId, cardId, controller.signal)) return;
      } catch (e) {
        if (!this.isRunActive(runId, cardId, controller.signal)) return;
        const reason = `loop provider unreachable: ${e instanceof Error ? e.message : String(e)}`;
        this.finishRun(runId, "failed", reason);
        this.moveCard(cardId, "looping", "needs_attention", reason);
        return;
      }

      // Spec 14 Phase 6: fail loudly before the first iteration if
      // sandboxEnabled but srt isn't actually usable — never fall back to
      // an unsandboxed loop silently. sandboxEnabled=false skips this
      // entirely; that operator choice is what `ctx.srtConfig` being
      // absent already communicates to the harness.
      if (settings.sandboxEnabled) {
        const preflight = await initializeSandboxRuntimeOnce();
        if (!this.isRunActive(runId, cardId, controller.signal)) return;
        if (!preflight.ok) {
          const reason = `sandbox unavailable: ${preflight.errors.join("; ")}`;
          this.finishRun(runId, "failed", reason);
          this.moveCard(cardId, "looping", "needs_attention", reason);
          return;
        }
      }

      let resolvedLoopModel = loopModel;
      if (loopProvider === "openrouter" && !loopModel) {
        const reason = "no model selected for the OpenRouter provider — pick one in Settings";
        this.finishRun(runId, "failed", reason);
        this.moveCard(cardId, "looping", "needs_attention", reason);
        return;
      }
      if (loopProvider === "omlx" && !loopModel) {
        try {
          const models = await listProviderModels("omlx", settings);
          if (!this.isRunActive(runId, cardId, controller.signal)) return;
          if (models.length > 0 && models[0].value) {
            resolvedLoopModel = models[0].value;
          } else {
            throw new Error("no models available from oMLX");
          }
        } catch (e) {
          if (!this.isRunActive(runId, cardId, controller.signal)) return;
          const reason = `failed to resolve oMLX model: ${e instanceof Error ? e.message : String(e)}`;
          this.finishRun(runId, "failed", reason);
          this.moveCard(cardId, "looping", "needs_attention", reason);
          return;
        }
      }

      const deadline = Date.now() + timeoutMs;
      // Spec 11: per-iteration hard timeout, capped by the run's remaining
      // budget. Floors keep a mistyped setting from making loops unrunnable.
      const hardTimeoutMs = Math.max(60_000, settings.iterationHardTimeoutMinutes * 60_000);
      let consecutiveFailures = 0;
      let consecutiveStalls = 0;
      let consecutiveIterationTimeouts = 0;
      let n = 0;

      const progressState = () => buildProgressState(worktreePath, planPath);

      while (n < maxIterations) {
        const remaining = deadline - Date.now();
        if (remaining < 30_000) {
          this.finishRun(runId, "timeout", "timeout", n);
          this.moveCard(cardId, "looping", "needs_attention", "timeout");
          return;
        }
        // Every iteration needs an unchecked task to inject — there is no
        // fallback prompt. An exhausted checklist here means the final task
        // ended without a DONE signal (e.g. its criteria failed).
        const planMd = fs.readFileSync(/* turbopackIgnore: true */ planPath, "utf8");
        const task = firstUnchecked(planMd);
        if (!task) {
          const reason = "plan checklist exhausted without a DONE signal";
          this.finishRun(runId, "failed", reason, n);
          this.moveCard(cardId, "looping", "needs_attention", reason);
          return;
        }
        n += 1;
        const iterName = `iter-${String(n).padStart(3, "0")}.jsonl`;
        const transcriptPath = path.join(runTranscriptDir(runId), iterName);
        const iter = db
          .insert(iterations)
          .values({
            runId,
            n,
            transcriptPath,
            taskNumber: task.taskNumber,
            taskCount: parseChecklist(planMd)?.items.length ?? task.taskNumber,
            taskText: task.item.text,
            startedAt: now(),
          })
          .returning()
          .get();
        emitEvent("iteration.started", { cardId, runId, payload: { n, maxIterations } });

        // Push new transcript lines over the SSE bus as the harness writes
        // them, instead of the UI polling (Phase 16 chunk A). Stopped in the
        // `finally` below, once runHarness settles and this iteration's file
        // is done being written.
        const stopTranscriptPush = startTranscriptPush(transcriptPath, runId, n);

        const before = await progressState();
        const preIteration = await captureIterationState(worktreePath);
        // Install-script gate trigger (spec 14): a changed lockfile
        // fingerprint after the iteration means an install happened.
        const lockfilesBefore = lockfileFingerprint(worktreePath);
        const promptMd = fs.readFileSync(
          path.join(/* turbopackIgnore: true */ ralphDir, "PROMPT.md"),
          "utf8",
        );
        const prompt = buildLoopPrompt(promptMd, planMd);
        // Soft signal only — spec 11 forbids terminating an iteration merely
        // for being slow; the hard timeout below is the enforcement point.
        const slowTimer = setTimeout(() => {
          emitEvent("iteration.slow", {
            cardId,
            runId,
            payload: { n, thresholdMs: SLOW_ITERATION_MS },
          });
        }, SLOW_ITERATION_MS);
        let result;
        try {
          result = await runHarness({
            provider: loopProvider,
            model: resolvedLoopModel,
            reasoningLevel: settings.loopReasoningLevel,
            prompt,
            cwd: worktreePath,
            transcriptPath,
            timeoutMs: Math.min(remaining, hardTimeoutMs),
            signal: controller.signal,
            role: "loop",
            runContext: ctx,
          });
        } finally {
          clearTimeout(slowTimer);
          stopTranscriptPush();
        }

        if (controller.signal.aborted) return; // cancelCard already finalized

        const failed = Boolean(result.error) || result.code !== 0;
        db.update(iterations)
          .set({
            status: failed ? "failed" : "completed",
            summary: result.error
              ? result.error.slice(0, 2000)
              : result.lastText.slice(0, 2000) || null,
            endedAt: now(),
            promptTokens: result.promptTokens,
            completionTokens: result.completionTokens,
            cachedInputTokens: result.cachedInputTokens,
            cacheWriteTokens: result.cacheWriteTokens,
            reasoningTokens: result.reasoningTokens,
            modelTurns: result.modelTurns,
            toolCalls: result.toolCalls,
            toolDurationMs: result.toolDurationMs,
            firstTokenMs: result.firstTokenMs,
            costUsd: result.costUsd,
            actualProvider: loopProvider,
            actualModel: resolvedLoopModel || null,
            harness: result.harness,
            harnessVersion: result.harnessVersion,
          })
          .where(eq(iterations.id, iter.id))
          .run();
        db.update(runs).set({ iterationsDone: n }).where(eq(runs.id, runId)).run();
        emitEvent("iteration.completed", {
          cardId,
          runId,
          payload: {
            n,
            failed,
            stuck: result.stuck,
            summary: (result.error || result.lastText).slice(0, 200),
          },
        });

        // DONE is the trigger for independent evaluation, not a direct pass to
        // review. Consume a same-iteration ITERATION_DONE first so the final
        // task gets its own deterministic commit; performDoneBookkeeping then
        // ticks whatever remains and commits the DONE file itself.
        if (doneFilePath(ralphDir)) {
          await performIterationBookkeeping({ ralphDir, worktreePath, planPath, pre: preIteration });
          await performDoneBookkeeping({ ralphDir, worktreePath, planPath });
          recordTaskCompleted(iter.id, planPath, task.taskNumber);
          // Spec 14 L3 run-end ordering: reap the process group FIRST (a
          // surviving process could plant hooks after a check that already
          // passed), then verify parent-repo integrity, then the install gate
          // (forced — nothing unapproved may reach the evaluator), and only
          // then hand over to evaluation.
          await ctx.reap();
          if (integrityBaseline) {
            const violations = await checkRepoIntegrity(repo.path, integrityBaseline, {
              runBranch: branch,
              checkRefs: true,
            });
            if (violations.length > 0) {
              const reason = `repo integrity violation: ${violations.join("; ")}`;
              this.finishRun(runId, "failed", reason, n);
              this.moveCard(cardId, "looping", "needs_attention", reason);
              return;
            }
          }
          if (await this.checkInstallGate({ cardId, runId, repoId: repo.id, worktreePath, n })) {
            return;
          }
          this.finishRun(runId, "completed", "done-signal", n);
          // Phase 3: every DONE goes through the evaluator before a human
          // sees it. An evaluator crash is a loud failure, not a pass-through.
          this.moveCard(cardId, "looping", "evaluating");
          void this.evaluationService.runEvaluator(cardId).catch((err) => {
            if (this.getCard(cardId)?.status === "evaluating") {
              this.moveCard(cardId, "evaluating", "needs_attention", String(err));
            }
          });
          return;
        }
        if (result.timedOut) {
          // When the iteration budget WAS the remaining run budget, this is
          // the run-level wall-clock cap — final, as before.
          if (remaining <= hardTimeoutMs) {
            this.finishRun(runId, "timeout", "timeout", n);
            this.moveCard(cardId, "looping", "needs_attention", "timeout");
            return;
          }
          // Per-iteration hard timeout: one retry with the worktree
          // preserved; two consecutive timeouts end the run (spec 11).
          consecutiveIterationTimeouts += 1;
          emitEvent("iteration.timeout", {
            cardId,
            runId,
            payload: { n, hardTimeoutMs, consecutive: consecutiveIterationTimeouts },
          });
          if (consecutiveIterationTimeouts >= 2) {
            this.finishRun(runId, "timeout", "iteration-timeout", n);
            this.moveCard(cardId, "looping", "needs_attention", "iteration-timeout");
            return;
          }
          continue;
        }
        consecutiveIterationTimeouts = 0;
        if (failed) {
          consecutiveFailures += 1;
          // A first-iteration connection/auth failure means the loop provider
          // is down or misconfigured — no point retrying. Status codes are
          // word-bounded so "4010 tokens" or a port number never matches.
          const isConnErr = CONN_ERROR_PATTERN.test(result.error);
          if (isConnErr) recordProviderOutcome(loopProvider, false);
          if (consecutiveFailures >= 3 || (n === 1 && isConnErr)) {
            const reason = `loop failed: ${result.error.slice(0, 300)}`;
            this.finishRun(runId, "failed", reason, n);
            this.moveCard(cardId, "looping", "needs_attention", reason);
            return;
          }
          continue;
        }
        consecutiveFailures = 0;
        recordProviderOutcome(loopProvider, true);

        // Handle the ITERATION_DONE signal: the orchestrator performs the
        // checklist tick and commit — the agent never does.
        const bkResult = await performIterationBookkeeping({
          ralphDir,
          worktreePath,
          planPath,
          pre: preIteration,
        });
        if (bkResult !== null && bkResult.advanced) {
          consecutiveStalls = 0;
        } else if (bkResult !== null) {
          // Phantom completion: ITERATION_DONE without any work product.
          // The checklist was NOT advanced, so the unchanged progress state
          // below feeds the normal stall counter.
          emitEvent("iteration.phantom", {
            cardId,
            runId,
            payload: { n, taskNumber: bkResult.taskNumber, summary: bkResult.summary.slice(0, 200) },
          });
        }
        // If bkResult is null (missing signal), fall through to stall detection
        recordTaskCompleted(iter.id, planPath, task.taskNumber);

        // Install-script gate (spec 14): fire on any lockfile change, after
        // bookkeeping so the iteration's signal files are fully consumed and
        // a resumed run starts its next iteration cleanly.
        if (lockfileFingerprint(worktreePath) !== lockfilesBefore) {
          if (await this.checkInstallGate({ cardId, runId, repoId: repo.id, worktreePath, n })) {
            return;
          }
        }

        if ((await progressState()) === before) {
          consecutiveStalls += 1;
          if (consecutiveStalls >= 3) {
            this.finishRun(runId, "failed", "stalled", n);
            this.moveCard(cardId, "looping", "needs_attention", "stalled");
            return;
          }
        } else {
          consecutiveStalls = 0;
        }

        if (this.pausedCards.has(cardId)) {
          this.finishRun(runId, "completed", "paused by user", n);
          this.moveCard(cardId, "looping", "paused", "paused by user");
          return;
        }
      }
      this.finishRun(runId, "failed", "max-iterations", n);
      this.moveCard(cardId, "looping", "needs_attention", "max-iterations");
    } finally {
      watchdog.stop();
      this.controllers.delete(runId);
      // Reaps every recorded process group, then removes the run-private
      // TMPDIR/caches — on every exit path including failure and cancel.
      await ctx.cleanup();
    }
  }

  /** Shared ballast file (spec 14): dead weight deleted on disk pressure so
   * the machine stays usable while a runaway run is being stopped. */
  private ballastPath(): string {
    return path.join(/* turbopackIgnore: true */ runScratchRoot(), "ballast");
  }

  /**
   * Install-script gate (spec 14). Scans the resolved dependency tree in the
   * worktree and, when any package's lifecycle scripts are unapproved for
   * this repo, halts the run into Needs Attention with the verbatim script
   * bodies in the event payload. Returns true when the gate fired. The model
   * never sees a prompt — decision 7 is intact.
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
    let approved: ApprovedInstallScript[] = [];
    try {
      approved = JSON.parse(repo.approvedInstallScripts) as ApprovedInstallScript[];
    } catch {
      // Corrupt store — treat as nothing approved (the safe direction).
    }
    const unapproved = unapprovedScripts(
      collectLifecycleScripts(opts.worktreePath),
      approved,
    );
    if (unapproved.length === 0) return false;

    const names = unapproved.map((p) => `${p.name}@${p.version}`).join(", ");
    const reason = `install-script gate: unapproved lifecycle scripts in ${names}`;
    emitEvent("install.gate", {
      cardId: opts.cardId,
      runId: opts.runId,
      payload: {
        packages: unapproved.map(({ name, version, scripts, scriptHash }) => ({
          name,
          version,
          scripts,
          scriptHash,
        })),
      },
    });
    // The run pauses with its state preserved (worktree + checklist ticks);
    // approval resumes it in place rather than requeueing to Todo.
    this.finishRun(opts.runId, "completed", "install-script gate", opts.n);
    this.moveCard(opts.cardId, "looping", "needs_attention", reason);
    return true;
  }

  /**
   * Approve specific packages' lifecycle scripts for a gate-halted card:
   * `npm rebuild` for the approved packages ONLY (per-package granularity),
   * record them in the repo's approved list, and resume the paused run in
   * place — back to the loop queue, or straight to evaluation when the
   * checklist finished before the gate fired.
   */
  async approveInstallScripts(
    cardId: string,
    packages: ApprovedInstallScript[],
  ): Promise<{ ok: true }> {
    const card = this.getCard(cardId);
    if (!card) throw new ClientError("card not found", 404);
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
    const requested = new Set(
      packages.map((p) => `${p.name}@${p.version}#${p.scriptHash}`),
    );
    const present = collectLifecycleScripts(run.worktreePath).filter((p) =>
      requested.has(`${p.name}@${p.version}#${p.scriptHash}`),
    );
    if (present.length === 0) {
      throw new ClientError(
        "none of the requested packages match the worktree's resolved tree — re-open the card to see the current gate state",
      );
    }

    const rebuild = await rebuildPackages(
      run.worktreePath,
      [...new Set(present.map((p) => p.name))],
    );
    if (!rebuild.ok) {
      throw new ClientError(`npm rebuild failed: ${rebuild.out.slice(0, 500)}`);
    }

    let approved: ApprovedInstallScript[] = [];
    try {
      approved = JSON.parse(repo.approvedInstallScripts) as ApprovedInstallScript[];
    } catch {
      approved = [];
    }
    const keys = new Set(approved.map((a) => `${a.name}@${a.version}#${a.scriptHash}`));
    for (const p of present) {
      const key = `${p.name}@${p.version}#${p.scriptHash}`;
      if (!keys.has(key)) {
        keys.add(key);
        approved.push({ name: p.name, version: p.version, scriptHash: p.scriptHash });
      }
    }
    db.update(repos)
      .set({ approvedInstallScripts: JSON.stringify(approved) })
      .where(eq(repos.id, repo.id))
      .run();
    emitEvent("install.approved", {
      cardId,
      runId: run.id,
      payload: { packages: present.map((p) => `${p.name}@${p.version}`) },
    });

    // Resume in place. A checklist with no unchecked task means the gate
    // fired on the DONE path — the loop already finished, so evaluation is
    // the next step, not another loop run.
    const planPath = planStatePath(cardId);
    const planMd = fs.existsSync(/* turbopackIgnore: true */ planPath)
      ? fs.readFileSync(/* turbopackIgnore: true */ planPath, "utf8")
      : "";
    if (planMd && !firstUnchecked(planMd)) {
      if (this.moveCard(cardId, "needs_attention", "evaluating", "install scripts approved")) {
        void this.evaluationService.runEvaluator(cardId).catch((error) => {
          if (this.getCard(cardId)?.status === "evaluating") {
            this.moveCard(cardId, "evaluating", "needs_attention", String(error));
          }
        });
      }
    } else {
      this.moveCard(cardId, "needs_attention", "ready", "install scripts approved");
      this.pump();
    }
    return { ok: true };
  }

  // ---- review actions ------------------------------------------------------

  approvePlan(cardId: string): { ok: boolean; error?: string } {
    return this.reviewService.approvePlan(cardId);
  }

  approve(runId: string): Promise<{ ok: boolean; error?: string }> {
    return this.reviewService.approve(runId);
  }

  retryMerge(cardId: string): Promise<{ ok: boolean; error?: string }> {
    return this.reviewService.retryMerge(cardId);
  }

  reject(runId: string, feedback: string) {
    return this.reviewService.reject(runId, feedback);
  }

  abandon(cardId: string) {
    return this.reviewService.abandon(cardId);
  }
  async resetCard(cardId: string) {
    const card = this.getCard(cardId);
    if (!card) throw new ClientError("card not found", 404);
    const repo = db.select().from(repos).where(eq(repos.id, card.repoId)).get()!;

    // Abort any currently running run.
    const active = db
      .select()
      .from(runs)
      .where(eq(runs.cardId, cardId))
      .orderBy(desc(runs.startedAt))
      .limit(1)
      .get();
    if (active && active.status === "running") {
      this.finishRun(active.id, "cancelled", "reset by user");
      db.update(iterations)
        .set({ status: "failed", summary: "reset by user", endedAt: now() })
        .where(eq(iterations.runId, active.id))
        .run();
      this.controllers.get(active.id)?.abort();
    }

    // Remove worktrees for ALL runs before deleting their rows.
    const allRuns = db.select().from(runs).where(eq(runs.cardId, cardId)).all();
    for (const run of allRuns) {
      if (fs.existsSync(/* turbopackIgnore: true */ run.worktreePath)) {
        await removeWorktree(repo.path, run.worktreePath, run.branch);
      }
    }
    removeRunTranscripts(allRuns.map((run) => run.id));
    for (const run of allRuns) removeBaseline(run.id);

    // Delete runs (cascades iterations + reviews), plans, and the private
    // plan checklist.
    db.delete(runs).where(eq(runs.cardId, cardId)).run();
    db.delete(plans).where(eq(plans.cardId, cardId)).run();
    db.delete(events).where(eq(events.cardId, cardId)).run();
    fs.rmSync(/* turbopackIgnore: true */ planStatePath(cardId), { force: true });

    // Clear card progress fields.
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
// handler can end up in different module graphs — Next.js bundles
// instrumentation separately from routes, in both dev and production builds.
// A class instantiated on one side (e.g. `new ClientError(...)` thrown
// through the orchestrator) is a *different* class object than the same
// class imported on the other side, so `instanceof` across that boundary is
// unreliable. See src/app/api/_lib.ts's `isClientError` for the fallback.
const g = globalThis as unknown as { __radulfOrchestrator?: Orchestrator };

export function getOrchestrator(): Orchestrator {
  return (g.__radulfOrchestrator ??= new Orchestrator());
}
