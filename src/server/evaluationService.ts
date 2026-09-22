import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, cards, runs, repos } from "@/db";
import { emitEvent } from "./events";
import { getSettings } from "./settings";
import { parseEvaluation } from "@/shared/evaluation";
import { isDocPath, changedPaths } from "@/shared/docPaths";
import { runTelemetry, type RunTelemetry } from "./harness";
import { normalizeProvider } from "./providers";
import { offRunBranchReason, tryGit } from "./git";
import { createRunSandbox } from "./sandbox/context";
import {
  registerRunBaseline,
  releaseRunBaseline,
  snapshotRepoIntegrity,
} from "./integrity";
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

/** Evaluator attempts share a worktree, but never another attempt's verdict. */
export function clearEvaluationArtifact(ralphDir: string) {
  fs.rmSync(path.join(/* turbopackIgnore: true */ ralphDir, "EVALUATION.md"), { force: true });
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
    const repo = db.select().from(repos).where(eq(repos.id, card.repoId)).get();
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
    const ralphDir = path.join(/* turbopackIgnore: true */ worktreePath, ".ralph");
    // A verdict left over from an earlier cycle must never be read as this run's.
    clearEvaluationArtifact(ralphDir);

    // Spec 14 L3: the evaluator holds bash, so it gets the same per-run
    // containment as the loop, including the parent-repo integrity check.
    const ctx = createRunSandbox(runId, { cwd: worktreePath, s: settings });
    const integrityBaseline = await snapshotRepoIntegrity(repo.path);
    // Spec 20: an evaluation runs long enough that another card's merge can
    // move this repo's base branch under it. Registering lets that merge
    // record its own write rather than this run reporting it as tampering.
    if (integrityBaseline) registerRunBaseline(runId, repo.path, integrityBaseline);
    startRunRow(
      { id: runId, cardId, planId: plan.id, kind: "evaluate", worktreePath, branch, baseBranch, provider, model },
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
      const breaker = circuitOpenReason(provider);
      if (breaker) return fail(breaker);
      const sandboxError = await sandboxUnavailableReason(settings);
      if (controller.signal.aborted) return; // cancelCard already finalized
      if (sandboxError) return fail(sandboxError);

      const headBefore = await head();
      const sourceStatusBefore = await sourceStatus();
      const result = await runWithTranscript({
        runId,
        file: "evaluate.jsonl",
        provider,
        model,
        reasoningLevel: settings.evaluatorReasoningLevel,
        prompt: renderEvaluatorPrompt(
          settings.evaluatorPromptTemplate,
          card.title,
          card.description,
          baseBranch,
          plan.acceptanceCriteria,
        ),
        cwd: worktreePath,
        timeoutMs: settings.evaluatorTimeoutMinutes * 60 * 1000,
        signal: controller.signal,
        role: "evaluator",
        runContext: ctx,
      });
      if (controller.signal.aborted) return; // cancelCard already finalized
      telemetry = runTelemetry(result);

      const failure = harnessFailure(result, provider, "evaluator");
      if (failure) return fail(failure.exitReason, failure.moveReason, failure.status);

      const violation = await integrityViolationReason(ctx, repo.path, integrityBaseline, branch);
      if (violation) return fail(violation);

      // The verdict commit below must land on the run branch and nowhere else.
      const offBranch = await offRunBranchReason(worktreePath, branch);
      if (offBranch) return fail(offBranch);

      // Spec 14: the judge provably cannot edit the implementation it judged.
      // It never commits (the orchestrator does, below), and its uncommitted
      // changes are narrowed to the doc allowlist.
      if ((await head()) !== headBefore) {
        return fail("evaluator committed to Git history; verdict rejected");
      }
      const changedBefore = new Set(changedPaths(sourceStatusBefore));
      const illegalPaths = changedPaths(await sourceStatus()).filter(
        (p) => !changedBefore.has(p) && !isDocPath(p),
      );
      if (illegalPaths.length > 0) {
        return fail(`evaluator modified non-doc files (${illegalPaths.join(", ")}); verdict rejected`);
      }

      const evaluationPath = path.join(/* turbopackIgnore: true */ ralphDir, "EVALUATION.md");
      const evaluation = fs.existsSync(/* turbopackIgnore: true */ evaluationPath)
        ? parseEvaluation(fs.readFileSync(/* turbopackIgnore: true */ evaluationPath, "utf8"))
        : null;
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
      const advanceToReview = async (exitReason: string, moveReason: string) => {
        const summaryPath = path.join(/* turbopackIgnore: true */ ralphDir, "SUMMARY.md");
        const summary = fs.existsSync(/* turbopackIgnore: true */ summaryPath)
          ? fs.readFileSync(/* turbopackIgnore: true */ summaryPath, "utf8").trim()
          : "";
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
        await advanceToReview("approve", "evaluator approved");
        // Auto-approve: merge straight through the same review path, granted
        // by the card's own flag or the global setting (a live override read
        // at verdict time; `source` records which one, since the global may
        // be flipped later). Only genuine `approve` verdicts qualify, and a
        // `critical` finding always leaves the card in review for a human.
        if ((card.autoApprove || getSettings().autoApprove) && !hasCritical) {
          emitEvent("card.auto_approved", {
            cardId,
            runId,
            payload: { runId: loopRun.id, source: card.autoApprove ? "card" : "global" },
          });
          try {
            await deps.approveReview(loopRun.id);
          } catch {
            // Best-effort: the review service restores a safe status on error,
            // which for auto-approve means the card falls back to human review.
          }
        }
        return;
      }

      const priorRevisions = db
        .select()
        .from(runs)
        .where(and(eq(runs.cardId, cardId), eq(runs.kind, "evaluate"), eq(runs.exitReason, "revise")))
        .all().length;
      if (priorRevisions >= MAX_EVALUATOR_REVISIONS) {
        await advanceToReview(
          "revise — revision limit reached",
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
        const reason = `evaluator failed: ${error instanceof Error ? error.message : String(error)}`;
        deps.finishRun(runId, "failed", reason.slice(0, 500));
        if (deps.getCard(cardId)?.status === "evaluating") {
          deps.moveCard(cardId, "evaluating", "needs_attention", reason);
        }
      }
    } finally {
      deps.releaseController(runId);
      releaseRunBaseline(runId);
      await ctx.cleanup();
      // Last, and on every exit path: the card has already landed wherever
      // this evaluation sent it, so the slot this run held is free.
      deps.pump();
    }
  }
}
