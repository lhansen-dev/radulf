import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, now, cards, plans, runs, repos, type CardStatus } from "@/db";
import { emitEvent } from "./events";
import { getSettings } from "./settings";
import { planStatePath } from "./bookkeeping";
import { appendTask } from "./checklist";
import { parseEvaluation } from "@/shared/evaluation";
import { isDocPath, changedPaths } from "@/shared/docPaths";
import { runHarness, runTelemetry, type RunTelemetry } from "./harness";
import { normalizeProvider } from "./providers";
import { CONN_ERROR_PATTERN, isProviderOpen, recordProviderOutcome } from "./circuitBreaker";
import { tryGit } from "./git";
import { runTranscriptDir } from "./retention";
import { startTranscriptPush } from "./transcript";
import { createRunSandbox } from "./sandbox/context";
import { initializeSandboxRuntimeOnce } from "./sandbox/srt";
import { checkRepoIntegrity, snapshotRepoIntegrity } from "./integrity";

type Card = typeof cards.$inferSelect;
type Plan = typeof plans.$inferSelect;
type Run = typeof runs.$inferSelect;

const EVALUATE_TIMEOUT_MS = 10 * 60 * 1000;
/** After this many revise verdicts on one card the evaluator stops
 * re-looping it and escalates to the human, unresolved feedback attached —
 * an evaluator and a struggling loop must not ping-pong forever. */
const MAX_EVALUATOR_REVISIONS = 2;
/** Checklist task injected so the resumed loop picks the feedback up —
 * every iteration runs on an injected task, never on prose in PROMPT.md. */
const EVALUATOR_FEEDBACK_TASK =
  'Address the feedback in the "Evaluator feedback — address this first" section at the top of your prompt: fix every point it raises, then re-run the checks it names.';

/** Evaluator attempts share a worktree, but never another attempt's verdict. */
export function clearEvaluationArtifact(ralphDir: string) {
  fs.rmSync(
    path.join(/* turbopackIgnore: true */ ralphDir, "EVALUATION.md"),
    { force: true },
  );
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

/**
 * Pure helper: a plan's PROMPT.md with any previous evaluator-feedback
 * preamble stripped, so only the newest verdict ever claims "address this
 * first". Reviewer (human) feedback sections are left untouched.
 */
export function basePromptMd(promptMd: string): string {
  if (!promptMd.startsWith("## Evaluator feedback — address this first\n")) return promptMd;
  const separator = "\n\n---\n\n";
  const index = promptMd.indexOf(separator);
  return index === -1 ? promptMd : promptMd.slice(index + separator.length);
}

export type EvaluationServiceDependencies = {
  getCard(cardId: string): Card | undefined;
  latestPlan(cardId: string): Plan | undefined;
  latestWorktreeRun(cardId: string): Run | undefined;
  moveCard(cardId: string, from: CardStatus, to: CardStatus, reason?: string): boolean;
  finishRun(
    runId: string,
    status: "completed" | "failed" | "timeout" | "cancelled",
    exitReason: string,
    telemetry?: RunTelemetry,
  ): boolean;
  registerController(runId: string, controller: AbortController): void;
  releaseController(runId: string): void;
  pump(): void;
  /** Run the human-approval merge path automatically (auto-approve). Reuses the
   * exact review flow — integrity re-check, merge, conflict re-loop — so
   * auto-approve never bypasses the load-bearing pre-merge checks. */
  approveReview(runId: string): Promise<{ ok: boolean; error?: string }>;
};

/**
 * Phase 3 — evaluate a DONE-signalled loop before human review. The
 * evaluator is the sole whole-card verifier: it runs CRITERIA.md and reads
 * the diff, then writes a verdict to `.ralph/EVALUATION.md`: `approve`
 * forwards the card to review with the evaluation attached; `revise` writes
 * the feedback into plan v(n+1) and hands the card straight back to the
 * loop. A missing or malformed verdict fails loudly to needs_attention —
 * never a silent pass-through.
 */
export class EvaluationService {
  constructor(private readonly dependencies: EvaluationServiceDependencies) {}

  async runEvaluator(cardId: string) {
    const deps = this.dependencies;
    const card = deps.getCard(cardId)!;
    const repo = db.select().from(repos).where(eq(repos.id, card.repoId)).get();
    if (!repo) throw new Error("repo not found");
    const plan = deps.latestPlan(cardId);
    if (!plan) throw new Error("card has no plan");
    const loopRun = deps.latestWorktreeRun(cardId);
    if (!loopRun) throw new Error("no worktree left to evaluate");
    const settings = getSettings();

    const runId = nanoid();
    const evaluatorProvider = normalizeProvider(settings.evaluatorProvider, "anthropic");
    const evaluatorModel = card.evaluatorModel || settings.evaluatorModel;
    const baseBranch = loopRun.baseBranch ?? repo.defaultBranch;
    const ralphDir = path.join(/* turbopackIgnore: true */ loopRun.worktreePath, ".ralph");
    const evaluationPath = path.join(/* turbopackIgnore: true */ ralphDir, "EVALUATION.md");
    // A verdict left over from an earlier cycle must never be read as this
    // run's output.
    clearEvaluationArtifact(ralphDir);

    // Spec 14 L3: the evaluator holds bash, so it gets the same per-run
    // containment as the loop — private TMPDIR/caches, allowlist env,
    // reaping, and a parent-repo integrity check at run end.
    const ctx = createRunSandbox(runId, { cwd: loopRun.worktreePath, s: settings });
    const integrityBaseline = await snapshotRepoIntegrity(repo.path);

    db.insert(runs)
      .values({
        id: runId,
        cardId,
        planId: plan.id,
        kind: "evaluate",
        worktreePath: loopRun.worktreePath,
        branch: loopRun.branch,
        baseBranch,
        provider: evaluatorProvider,
        model: evaluatorModel,
        startedAt: now(),
        diskLimitMechanism: ctx.diskLimitMechanism,
        sandboxed: settings.sandboxEnabled ? 1 : 0,
      })
      .run();
    // events.run_id is a real FK — emit only now that the run row exists
    // (PLAN.md Phase 18.1: createRunSandbox used to emit this itself, before
    // this insert, and crashed run start whenever the flag was on).
    if (ctx.weakerIsolationEnabled) {
      emitEvent("sandbox.weaker_isolation_enabled", {
        cardId,
        runId,
        payload: { reason: "sandboxWeakerIsolationForGoTls" },
      });
    }
    emitEvent("run.started", { cardId, runId, payload: { kind: "evaluate" } });

    const controller = new AbortController();
    deps.registerController(runId, controller);
    try {
      // Circuit breaker: a provider with recent connection/auth failures
      // fails this run fast instead of repeating the same slow failure.
      if (isProviderOpen(evaluatorProvider)) {
        const reason = `provider ${evaluatorProvider} circuit breaker open — recent connection failures, will retry automatically after cooldown`;
        deps.finishRun(runId, "failed", reason);
        deps.moveCard(cardId, "evaluating", "needs_attention", reason);
        return;
      }

      // Spec 14 Phase 6: fail loudly before the first (only) iteration if
      // sandboxEnabled but srt isn't actually usable — same posture as the
      // loop's preflight, never a silent unsandboxed fallback.
      if (settings.sandboxEnabled) {
        const preflight = await initializeSandboxRuntimeOnce();
        if (controller.signal.aborted) return; // cancelCard already finalized
        if (!preflight.ok) {
          const reason = `sandbox unavailable: ${preflight.errors.join("; ")}`;
          deps.finishRun(runId, "failed", reason);
          deps.moveCard(cardId, "evaluating", "needs_attention", reason);
          return;
        }
      }

      const prompt = renderEvaluatorPrompt(
        settings.evaluatorPromptTemplate,
        card.title,
        card.description,
        baseBranch,
        plan.acceptanceCriteria,
      );
      const headBefore = (await tryGit(loopRun.worktreePath, "rev-parse", "HEAD")).out;
      const sourceStatusBefore = (await tryGit(
        loopRun.worktreePath,
        "status",
        "--porcelain",
        "--",
        ".",
        ":(exclude).ralph",
      )).out;
      // Live transcript push (Phase 16 chunk A) — single-file transcripts
      // (plan/evaluate) always use iteration 0, matching the `singleFile`
      // convention in /api/runs/[id]'s route and the TranscriptTarget the
      // card page builds for a non-loop run.
      const evaluateTranscriptPath = path.join(runTranscriptDir(runId), "evaluate.jsonl");
      const stopTranscriptPush = startTranscriptPush(evaluateTranscriptPath, runId, 0);
      let result;
      try {
        result = await runHarness({
          provider: evaluatorProvider,
          model: evaluatorModel,
          reasoningLevel: settings.evaluatorReasoningLevel,
          prompt,
          cwd: loopRun.worktreePath,
          transcriptPath: evaluateTranscriptPath,
          timeoutMs: EVALUATE_TIMEOUT_MS,
          signal: controller.signal,
          role: "evaluator",
          runContext: ctx,
        });
      } finally {
        stopTranscriptPush();
      }
      if (controller.signal.aborted) return; // cancelCard already finalized

      if (result.timedOut) {
        deps.finishRun(runId, "timeout", "evaluation timed out", runTelemetry(result));
        deps.moveCard(cardId, "evaluating", "needs_attention", "evaluation timed out");
        return;
      }
      // A dead stream, not a verdict — worth its own reason so it isn't read
      // as the evaluator rejecting the work.
      if (result.stalled) {
        deps.finishRun(
          runId,
          "failed",
          `evaluator stalled: ${result.error.slice(0, 500)}`,
          runTelemetry(result),
        );
        deps.moveCard(cardId, "evaluating", "needs_attention", "evaluator stalled");
        return;
      }
      if (result.error) {
        if (CONN_ERROR_PATTERN.test(result.error)) recordProviderOutcome(evaluatorProvider, false);
        deps.finishRun(
          runId,
          "failed",
          `evaluator failed: ${result.error.slice(0, 500)}`,
          runTelemetry(result),
        );
        deps.moveCard(cardId, "evaluating", "needs_attention", "evaluator failed");
        return;
      }
      recordProviderOutcome(evaluatorProvider, true);

      // Spec 14 run-end ordering: reap surviving processes BEFORE any
      // integrity conclusions are drawn, then verify the parent repo.
      await ctx.reap();
      if (integrityBaseline) {
        const violations = await checkRepoIntegrity(repo.path, integrityBaseline, {
          runBranch: loopRun.branch,
          checkRefs: true,
        });
        if (violations.length > 0) {
          const reason = `repo integrity violation: ${violations.join("; ")}`;
          deps.finishRun(runId, "failed", reason, runTelemetry(result));
          deps.moveCard(cardId, "evaluating", "needs_attention", reason);
          return;
        }
      }

      // Spec 14: the judge provably cannot edit the implementation it judged.
      // Git history stays immutable — the evaluator never commits (the
      // orchestrator does, below). Uncommitted changes are narrowed to the
      // doc allowlist: on approve the evaluator may refresh stale docs, but
      // any code change (or a non-doc path) still rejects to needs_attention.
      const headAfter = (await tryGit(loopRun.worktreePath, "rev-parse", "HEAD")).out;
      if (headAfter !== headBefore) {
        const reason = "evaluator committed to Git history; verdict rejected";
        deps.finishRun(runId, "failed", reason, runTelemetry(result));
        deps.moveCard(cardId, "evaluating", "needs_attention", reason);
        return;
      }
      const sourceStatusAfter = (await tryGit(
        loopRun.worktreePath,
        "status",
        "--porcelain",
        "--",
        ".",
        ":(exclude).ralph",
      )).out;
      const changedBefore = new Set(changedPaths(sourceStatusBefore));
      const illegalPaths = changedPaths(sourceStatusAfter).filter(
        (p) => !changedBefore.has(p) && !isDocPath(p),
      );
      if (illegalPaths.length > 0) {
        const reason = `evaluator modified non-doc files (${illegalPaths.join(", ")}); verdict rejected`;
        deps.finishRun(runId, "failed", reason, runTelemetry(result));
        deps.moveCard(cardId, "evaluating", "needs_attention", reason);
        return;
      }

      const evaluation = fs.existsSync(/* turbopackIgnore: true */ evaluationPath)
        ? parseEvaluation(
            fs.readFileSync(/* turbopackIgnore: true */ evaluationPath, "utf8"),
          )
        : null;
      if (!evaluation) {
        const reason = "evaluator wrote no usable VERDICT in .ralph/EVALUATION.md";
        deps.finishRun(runId, "failed", reason, runTelemetry(result));
        deps.moveCard(cardId, "evaluating", "needs_attention", reason);
        return;
      }

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

      // Spec 14: the evaluator (not a separate summarizer) writes the card
      // summary and, on approve, refreshes stale docs. Read the summary it
      // left in `.ralph/SUMMARY.md`; a missing summary is non-fatal.
      const applySummary = () => {
        const summaryPath = path.join(/* turbopackIgnore: true */ ralphDir, "SUMMARY.md");
        if (!fs.existsSync(/* turbopackIgnore: true */ summaryPath)) return;
        const summary = fs
          .readFileSync(/* turbopackIgnore: true */ summaryPath, "utf8")
          .trim();
        if (!summary) return;
        db.update(cards).set({ summary }).where(eq(cards.id, cardId)).run();
        emitEvent("card.summarized", { cardId, runId });
      };

      // Cards that advance straight to human review (approve, or a revise that
      // hit the limit) carry the summary and the evaluator's doc edits onto the
      // review branch (`add -A`); `.ralph` is stripped at merge, the docs stay.
      const advanceToReview = async (exitReason: string, moveReason: string) => {
        applySummary();
        await tryGit(loopRun.worktreePath, "add", "-A");
        await tryGit(loopRun.worktreePath, "commit", "-m", `ralph: evaluation — ${evaluation.verdict}`);
        deps.finishRun(runId, "completed", exitReason, runTelemetry(result));
        deps.moveCard(cardId, "evaluating", "review", moveReason);
      };

      if (evaluation.verdict === "approve") {
        await advanceToReview("approve", "evaluator approved");
        // Auto-approve (per-card, opt-in): skip the human In Review gate and
        // merge straight through the same review path. Only genuine `approve`
        // verdicts qualify — the revision-limit escalation below always waits
        // for a human. On any merge/claim failure `approveReview` leaves the
        // card in review (or needs_attention), so a human still sees it. A
        // `critical` finding always forces human review, even here — the
        // card stays in `review` (set by `advanceToReview` above) instead of
        // auto-merging.
        if (card.autoApprove && !hasCritical) {
          emitEvent("card.auto_approved", { cardId, runId, payload: { runId: loopRun.id } });
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
        .where(
          and(eq(runs.cardId, cardId), eq(runs.kind, "evaluate"), eq(runs.exitReason, "revise")),
        )
        .all().length;
      if (priorRevisions >= MAX_EVALUATOR_REVISIONS) {
        await advanceToReview(
          "revise — revision limit reached",
          "evaluator revision limit — escalated to human review",
        );
        return;
      }

      // A revise that re-loops carries only the verdict artifact back (the
      // prompt forbids doc edits on revise, so `.ralph` is all that changed).
      await tryGit(loopRun.worktreePath, "add", ".ralph");
      await tryGit(loopRun.worktreePath, "commit", "-m", "ralph: evaluation — revise");

      const promptMd = `## Evaluator feedback — address this first\n\n${evaluation.feedback}\n\n---\n\n${basePromptMd(plan.promptMd)}`;
      const revisionPlanId = nanoid();
      const planPath = planStatePath(cardId);
      if (!fs.existsSync(/* turbopackIgnore: true */ planPath)) {
        throw new Error("evaluator cannot requeue feedback: private plan state is missing");
      }
      const updatedPlanState = appendTask(
        fs.readFileSync(/* turbopackIgnore: true */ planPath, "utf8"),
        EVALUATOR_FEEDBACK_TASK,
      );
      try {
        db.insert(plans)
          .values({
            id: revisionPlanId,
            cardId,
            version: plan.version + 1,
            planMd: plan.planMd,
            promptMd,
            acceptanceCriteria: plan.acceptanceCriteria,
            feedback: evaluation.feedback,
            createdAt: now(),
          })
          .run();
        fs.writeFileSync(/* turbopackIgnore: true */ planPath, updatedPlanState);
      } catch (error) {
        db.delete(plans).where(eq(plans.id, revisionPlanId)).run();
        throw error;
      }
      emitEvent("plan.created", { cardId, runId, payload: { version: plan.version + 1 } });
      deps.finishRun(runId, "completed", "revise", runTelemetry(result));
      deps.moveCard(cardId, "evaluating", "ready", "evaluator requested changes");
      deps.pump();
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
      await ctx.cleanup();
    }
  }
}
