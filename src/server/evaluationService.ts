import fs from "node:fs";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, cards, runs } from "@/db";
import { emitEvent } from "./events";
import { getSettings } from "./settings";
import { ralphDirPath, readFileIfExists, removeRalphFiles } from "./bookkeeping";
import { GATE_FILE, gateFilePath, renderGateFile, renderGateSection, runGateCommand, type GateResult } from "./gate";
import {
  EVALUATION_NOTES_FILE,
  EVALUATION_NOTES_SECTION,
  attemptTranscriptPath,
  digestTranscript,
  previousFailedAttempt,
  renderDeadlineSection,
  renderPreviousAttemptSection,
} from "./previousAttempt";
import { EVALUATOR_CLEARED_EXITS, parseEvaluation } from "@/shared/evaluation";
import { isDocPath, changedPaths } from "@/shared/docPaths";
import { errorMessage } from "@/shared/errorMessage";
import { runTelemetry, type RunTelemetry } from "./harness";
import { normalizeProvider } from "./providers";
import { offRunBranchReason, tryGit } from "./git";
import { getRepo } from "./repos";
import { createRunSandbox } from "./sandbox/context";
import { snapshotRepoIntegrity } from "./integrity";
import {
  circuitOpenReason,
  harnessFailure,
  integrityViolationReason,
  runWithTranscript,
  sandboxUnavailableReason,
  startRunRow,
  type FinishStatus,
  type StageDependencies,
} from "./stage";

/** After this many revise verdicts on one card the evaluator stops
 * re-looping it and escalates to the human, unresolved feedback attached —
 * an evaluator and a struggling loop must not ping-pong forever. */
const MAX_EVALUATOR_REVISIONS = 2;

const [APPROVED_EXIT, REVISION_LIMIT_EXIT] = EVALUATOR_CLEARED_EXITS;

/** Evaluator attempts share a worktree, but never another attempt's verdict. */
export function clearEvaluationArtifact(worktreePath: string) {
  removeRalphFiles(worktreePath, ["EVALUATION.md"]);
}

export function renderEvaluatorPrompt(
  template: string,
  title: string,
  description: string,
  baseBranch: string,
  criteria: string,
) {
  return template
    .replaceAll("{{TITLE}}", title)
    .replaceAll("{{DESCRIPTION}}", description || "(no description)")
    .replaceAll("{{BASE_BRANCH}}", baseBranch)
    .replaceAll("{{CRITERIA}}", criteria.trim() || "(no acceptance criteria were recorded)");
}

export type EvaluationServiceDependencies = StageDependencies & {
  /** Advance the repo's queue once this evaluation releases its slot. Every
   * other stage already did this; without it a repo with cards waiting sits
   * idle until an unrelated event pumps (spec 20). */
  pump(): void;
  /** Run the planner on a card already moved to `planning` — a revise verdict
   * re-plans rather than re-entering the loop. */
  replan(cardId: string): void;
  /** Run the human-approval merge path automatically (auto-approve). Reuses the
   * exact review flow — integrity re-check, merge, conflict re-loop — so
   * auto-approve never bypasses the load-bearing pre-merge checks. */
  approveReview(runId: string): Promise<{ ok: boolean; error?: string }>;
};

/**
 * Phase 3 — evaluate a DONE-signalled loop before human review. The
 * evaluator is the sole whole-card verifier: it runs CRITERIA.md and reads
 * the diff, then writes a verdict to `.ralph/EVALUATION.md`: `approve`
 * forwards the card to review with the evaluation attached; `revise` records
 * the feedback on the run and sends the card back to the planner. A missing
 * or malformed verdict fails loudly to needs_attention — never a silent
 * pass-through.
 */
export class EvaluationService {
  constructor(private readonly deps: EvaluationServiceDependencies) {}

  async runEvaluator(cardId: string) {
    const deps = this.deps;
    const card = deps.getCard(cardId)!;
    const repo = getRepo(card.repoId);
    if (!repo) throw new Error("repo not found");
    const plan = deps.latestPlan(cardId);
    if (!plan) throw new Error("card has no plan");
    const loopRun = deps.latestWorktreeRun(cardId);
    if (!loopRun) throw new Error("no worktree left to evaluate");
    const settings = getSettings();

    const runId = nanoid();
    const provider = normalizeProvider(settings.evaluatorProvider, "anthropic");
    const model = card.evaluatorModel || settings.evaluatorModel;
    const { worktreePath, branch } = loopRun;
    const baseBranch = loopRun.baseBranch ?? repo.defaultBranch;
    const ralphDir = ralphDirPath(worktreePath);
    // Spec 26: a retry inherits the attempt it retries. Decided before this
    // run's row exists, since the rule reads the card's latest run.
    const previous = previousFailedAttempt(cardId, "evaluate");
    // A verdict left over from an earlier cycle must never be read as this run's.
    clearEvaluationArtifact(worktreePath);
    // The running notes belong to one evaluation cycle: kept across its
    // attempts, cleared when a new loop run has started a fresh one.
    if (!previous) removeRalphFiles(worktreePath, [EVALUATION_NOTES_FILE]);

    // Spec 14 L3: the evaluator holds bash, so it gets the same per-run
    // containment as the loop, including the parent-repo integrity check.
    const ctx = await createRunSandbox(runId, { cwd: worktreePath, s: settings });
    const integrityBaseline = await snapshotRepoIntegrity(repo.path);
    startRunRow(
      {
        id: runId,
        cardId,
        planId: plan.id,
        kind: "evaluate",
        worktreePath,
        branch,
        baseBranch,
        provider,
        model,
        workerId: deps.workerId(),
      },
      ctx,
      settings,
    );
    emitEvent("run.started", { cardId, runId, payload: { kind: "evaluate" } });

    const controller = new AbortController();
    deps.registerController(runId, controller);
    let telemetry: RunTelemetry | undefined;
    const fail = (exitReason: string, moveReason = exitReason, status: FinishStatus = "failed") => {
      deps.finishRun(runId, status, exitReason, telemetry);
      deps.moveCard(cardId, "evaluating", "needs_attention", moveReason);
    };
    const sourceStatus = async () =>
      (await tryGit(worktreePath, "status", "--porcelain", "--", ".", ":(exclude).ralph")).out;
    const head = async () => (await tryGit(worktreePath, "rev-parse", "HEAD")).out;
    try {
      // The awaited sandbox and integrity setup above open a window where the
      // user can cancel before this run row existed. endActiveRun found
      // nothing to abort then, so check here and never start a harness for
      // a card that already left.
      if (deps.getCard(cardId)?.status !== "evaluating") {
        deps.finishRun(runId, "cancelled", "card left evaluating before the run started");
        return;
      }
      const breaker = circuitOpenReason(provider);
      if (breaker) return fail(breaker);
      const sandboxError = await sandboxUnavailableReason(settings);
      if (controller.signal.aborted) return; // cancelCard already finalized
      if (sandboxError) return fail(sandboxError);

      // Spec 27: the repository gate runs here, by the orchestrator, so the
      // evaluator judges its result instead of spending its budget producing
      // it. Once per evaluation cycle: a retry reuses the file the cycle's
      // first attempt left, a fresh cycle after a new loop run starts over.
      // Before the status snapshot below, so whatever a build leaves in the
      // worktree is never attributed to the evaluator.
      const gatePath = gateFilePath(worktreePath);
      if (!previous) removeRalphFiles(worktreePath, [GATE_FILE]);
      const gateCommand = repo.gateCommand?.trim() ?? "";
      if (gateCommand && !fs.existsSync(/* turbopackIgnore: true */ gatePath)) {
        emitEvent("gate.started", { cardId, runId, payload: { command: gateCommand } });
        let gate: GateResult;
        try {
          gate = await runGateCommand({
            command: gateCommand,
            worktreePath,
            ctx,
            timeoutMs: settings.gateTimeoutMinutes * 60 * 1000,
            signal: controller.signal,
          });
        } catch (error) {
          if (controller.signal.aborted) return; // cancelCard already finalized
          throw error;
        }
        if (controller.signal.aborted) return; // cancelCard already finalized
        fs.writeFileSync(/* turbopackIgnore: true */ gatePath, renderGateFile(gate));
        emitEvent("gate.finished", {
          cardId,
          runId,
          payload: { exitCode: gate.exitCode, timedOut: gate.timedOut, durationMs: gate.durationMs, error: gate.error },
        });
      }
      const gateSection = gateCommand ? renderGateSection(readFileIfExists(gatePath)) : "";

      const [headBefore, sourceStatusBefore] = await Promise.all([head(), sourceStatus()]);
      // Spec 26: the previous attempt's notes and command digest, the running
      // notes protocol, and the clock, appended outside the template so a
      // customized template still receives them.
      let previousSection = "";
      if (previous) {
        const digest = digestTranscript(attemptTranscriptPath(previous));
        previousSection = renderPreviousAttemptSection({
          stage: "evaluator",
          attempt: previous,
          digest,
          notes: readFileIfExists(path.join(/* turbopackIgnore: true */ ralphDir, EVALUATION_NOTES_FILE)),
        });
        emitEvent("attempt.forwarded", {
          cardId,
          runId,
          payload: { kind: "evaluate", previousRunId: previous.runId, toolCalls: digest.toolCalls },
        });
      }
      const timeoutMs = settings.evaluatorTimeoutMinutes * 60 * 1000;
      const prompt =
        renderEvaluatorPrompt(
          settings.evaluatorPromptTemplate,
          card.title,
          card.description,
          baseBranch,
          plan.acceptanceCriteria,
        ) +
        previousSection +
        gateSection +
        EVALUATION_NOTES_SECTION +
        renderDeadlineSection("evaluator", new Date(), timeoutMs);
      const result = await runWithTranscript({
        runId,
        file: "evaluate.jsonl",
        provider,
        model,
        reasoningLevel: settings.evaluatorReasoningLevel,
        prompt,
        cwd: worktreePath,
        timeoutMs,
        signal: controller.signal,
        role: "evaluator",
        runContext: ctx,
      });
      if (controller.signal.aborted) return; // cancelCard already finalized
      telemetry = runTelemetry(result);

      // Spec 26 decision 4: a complete verdict on disk outlives the watchdog
      // that killed the session, the way a loop's signal file does (spec 18
      // item 1). Every check below still applies to it.
      const evaluationPath = path.join(/* turbopackIgnore: true */ ralphDir, "EVALUATION.md");
      const recovered =
        (result.timedOut || result.stalled) && parseEvaluation(readFileIfExists(evaluationPath)) !== null;
      if (recovered) {
        emitEvent("evaluation.recovered_after_timeout", {
          cardId,
          runId,
          payload: { cause: result.timedOut ? "timeout" : "stalled" },
        });
      } else {
        const failure = harnessFailure(result, provider, "evaluator");
        if (failure) return fail(failure.exitReason, failure.moveReason, failure.status);
      }

      const violation = await integrityViolationReason(ctx, repo.path, integrityBaseline, branch);
      if (violation) return fail(violation);

      // The verdict commit below must land on the run branch and nowhere else.
      const offBranch = await offRunBranchReason(worktreePath, branch, repo.path);
      if (offBranch) return fail(offBranch);

      // Spec 14: the judge provably cannot edit the implementation it judged.
      // It never commits (the orchestrator does, below), and its uncommitted
      // changes are narrowed to the doc allowlist.
      const [headAfter, sourceStatusAfter] = await Promise.all([head(), sourceStatus()]);
      if (headAfter !== headBefore) {
        return fail("evaluator committed to Git history; verdict rejected");
      }
      const changedBefore = new Set(changedPaths(sourceStatusBefore));
      const illegalPaths = changedPaths(sourceStatusAfter).filter(
        (p) => !changedBefore.has(p) && !isDocPath(p),
      );
      if (illegalPaths.length > 0) {
        return fail(`evaluator modified non-doc files (${illegalPaths.join(", ")}); verdict rejected`);
      }

      const evaluationMd = readFileIfExists(path.join(/* turbopackIgnore: true */ ralphDir, "EVALUATION.md"));
      const evaluation = evaluationMd ? parseEvaluation(evaluationMd) : null;
      if (!evaluation) return fail("evaluator wrote no usable VERDICT in .ralph/EVALUATION.md");

      const hasCritical = evaluation.findings.some((f) => f.severity === "critical");
      emitEvent("evaluation.decided", {
        cardId,
        runId,
        payload: {
          verdict: evaluation.verdict,
          feedback: evaluation.feedback.slice(0, 500),
          findings: evaluation.findings,
        },
      });

      // Cards that advance straight to human review (approve, or a revise that
      // hit the limit) carry the evaluator's `.ralph/SUMMARY.md` onto the card
      // and its doc edits onto the review branch (`add -A`); `.ralph` is
      // stripped at merge, the docs stay. A missing summary is non-fatal.
      const advanceToReview = async (
        exitReason: (typeof EVALUATOR_CLEARED_EXITS)[number],
        moveReason: string,
      ) => {
        const summary = readFileIfExists(path.join(/* turbopackIgnore: true */ ralphDir, "SUMMARY.md")).trim();
        if (summary) {
          db.update(cards).set({ summary }).where(eq(cards.id, cardId)).run();
          emitEvent("card.summarized", { cardId, runId });
        }
        await tryGit(worktreePath, "add", "-A");
        await tryGit(worktreePath, "commit", "-m", `ralph: evaluation — ${evaluation.verdict}`);
        deps.finishRun(runId, "completed", exitReason, telemetry);
        deps.moveCard(cardId, "evaluating", "review", moveReason);
      };

      if (evaluation.verdict === "approve") {
        await advanceToReview(APPROVED_EXIT, "evaluator approved");
        // Auto-approve: merge straight through the same review path, granted
        // by the card's own flag or the global setting (a live override read
        // at verdict time; `source` records which one, since the global may
        // be flipped later). Only genuine `approve` verdicts qualify, and a
        // `critical` finding always leaves the card in review for a human.
        if ((card.autoApprove || getSettings().autoApprove) && !hasCritical) {
          // The run to approve is the card's latest loop run. `loopRun` above
          // is the latest run with a worktree, which after an evaluator retry
          // is the failed evaluate attempt, and the review service rightly
          // refuses to merge anything but a completed loop run.
          const latestLoop = db
            .select({ id: runs.id })
            .from(runs)
            .where(and(eq(runs.cardId, cardId), eq(runs.kind, "loop")))
            .orderBy(desc(runs.startedAt))
            .limit(1)
            .get();
          const approveRunId = latestLoop?.id ?? loopRun.id;
          emitEvent("card.auto_approved", {
            cardId,
            runId,
            payload: { runId: approveRunId, source: card.autoApprove ? "card" : "global" },
          });
          try {
            await deps.approveReview(approveRunId);
          } catch {
            // Best-effort: the review service restores a safe status on error,
            // which for auto-approve means the card falls back to human review.
          }
        }
        return;
      }

      const priorRevisions = db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.cardId, cardId), eq(runs.kind, "evaluate"), eq(runs.exitReason, "revise")))
        .all().length;
      if (priorRevisions >= MAX_EVALUATOR_REVISIONS) {
        await advanceToReview(
          REVISION_LIMIT_EXIT,
          "evaluator revision limit — escalated to human review",
        );
        return;
      }

      // A revise goes back to the planner, not straight to the loop (see
      // `pendingReplanFeedback`). The prompt forbids doc edits on revise, so
      // `.ralph` is all that changed.
      await tryGit(worktreePath, "add", ".ralph");
      await tryGit(worktreePath, "commit", "-m", "ralph: evaluation — revise");
      db.update(runs).set({ feedback: evaluation.feedback }).where(eq(runs.id, runId)).run();
      deps.finishRun(runId, "completed", "revise", telemetry);
      // The card keeps its repo's pipeline slot: straight into planning,
      // never back through a queue another card could claim first.
      if (deps.moveCard(cardId, "evaluating", "planning", "evaluator requested changes — re-planning")) {
        deps.replan(cardId);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const reason = `evaluator failed: ${errorMessage(error)}`;
        deps.finishRun(runId, "failed", reason.slice(0, 500));
        if (deps.getCard(cardId)?.status === "evaluating") {
          deps.moveCard(cardId, "evaluating", "needs_attention", reason);
        }
      }
    } finally {
      deps.releaseController(runId);
      await ctx.cleanup();
      // Last, and on every exit path: the card has already landed wherever
      // this evaluation sent it, so the slot this run held is free.
      deps.pump();
    }
  }
}
