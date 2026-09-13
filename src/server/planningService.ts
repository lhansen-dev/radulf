import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, now, cards, plans, runs, repos, type CardStatus } from "@/db";
import { emitEvent } from "./events";
import { getSettings } from "./settings";
import { planStatePath } from "./bookkeeping";
import { firstUnchecked } from "./checklist";
import { runHarness, runTelemetry, type RunTelemetry } from "./harness";
import { normalizeProvider } from "./providers";
import { CONN_ERROR_PATTERN, isProviderOpen, recordProviderOutcome } from "./circuitBreaker";
import { createWorktree, recordWorktree, tryGit, currentBranch } from "./git";
import { runTranscriptDir } from "./retention";
import { startTranscriptPush } from "./transcript";
import { createRunSandbox } from "./sandbox/context";

type Card = typeof cards.$inferSelect;
type Plan = typeof plans.$inferSelect;
type Run = typeof runs.$inferSelect;

const RALPH_FILES = ["PLAN.md", "CRITERIA.md", "PROMPT.md"] as const;
const PLANNER_FILES = ["QUESTIONS.md", ...RALPH_FILES] as const;

/** Planner retries intentionally reuse a worktree, but never another
 * attempt's output. Each invocation must earn a complete artifact set. */
export function clearPlannerArtifacts(worktreePath: string) {
  const ralphDir = path.join(/* turbopackIgnore: true */ worktreePath, ".ralph");
  for (const file of PLANNER_FILES) {
    fs.rmSync(path.join(/* turbopackIgnore: true */ ralphDir, file), { force: true });
  }
}

export function renderPlanPrompt(
  template: string,
  title: string,
  description: string,
  feedback?: string,
) {
  const feedbackSection = feedback
    ? `\nPREVIOUS ATTEMPT — REVIEWER FEEDBACK\n====================================\n${feedback}\n`
    : "";
  return template
    .replaceAll("{{TITLE}}", title)
    .replaceAll("{{DESCRIPTION}}", description || "(no description)")
    .replaceAll("{{FEEDBACK_SECTION}}", feedbackSection);
}

/**
 * Pure helper: determine a card's destination status after successful planning.
 * Opted-in cards pause for human review; ordinary cards proceed straight to ready.
 */
export function planningDestination(
  card: { reviewPlanBeforeImplementation: number }
): "plan_review" | "ready" {
  return card.reviewPlanBeforeImplementation ? "plan_review" : "ready";
}

export type PlanningServiceDependencies = {
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
};

/**
 * Owns the planning run: worktree setup, the planner harness invocation, and
 * artifact validation. Queue scheduling and run/card state stay behind
 * injected callbacks, mirroring ReviewService.
 */
export class PlanningService {
  constructor(private readonly dependencies: PlanningServiceDependencies) {}

  async runPlanning(cardId: string) {
    const deps = this.dependencies;
    const card = deps.getCard(cardId)!;
    const repo = db.select().from(repos).where(eq(repos.id, card.repoId)).get();
    if (!repo) throw new Error("repo not found");
    const settings = getSettings();

    const runId = nanoid();
    const plannerProvider = normalizeProvider(settings.plannerProvider, "anthropic");
    const plannerModel = card.plannerModel || settings.plannerModel;
    // Reuse the card's existing worktree (retry after a failed/cancelled plan
    // run) or make a fresh one — mirrors the loop's reuse.
    const prev = deps.latestWorktreeRun(cardId);
    const baseBranch =
      prev?.baseBranch ?? card.baseBranch ?? (await currentBranch(repo.path, repo.defaultBranch));
    let worktreePath: string;
    let branch: string;
    if (prev) {
      ({ worktreePath, branch } = prev);
    } else {
      ({ worktreePath, branch } = await createWorktree(repo.path, baseBranch, card.title, runId));
    }
    clearPlannerArtifacts(worktreePath);
    // Spec 14 Phase 3: the planner's ONLY L2 write root is the worktree's
    // `.ralph/` (where planningService and the loop consume its artifacts) —
    // it can read the whole checkout but write nothing else. Ensure the dir
    // exists so the write root resolves before the planner starts.
    fs.mkdirSync(path.join(/* turbopackIgnore: true */ worktreePath, ".ralph"), {
      recursive: true,
    });
    // Spec 14 L3: per-run private TMPDIR/caches + allowlist env + reaping.
    const ctx = createRunSandbox(runId);
    db.insert(runs)
      .values({
        id: runId,
        cardId,
        kind: "plan",
        worktreePath,
        branch,
        baseBranch,
        provider: plannerProvider,
        model: plannerModel,
        startedAt: now(),
        diskLimitMechanism: ctx.diskLimitMechanism,
        sandboxed: settings.sandboxEnabled ? 1 : 0,
      })
      .run();
    // worktrees.runId is a real FK — record the worktree only now that its
    // owning run row exists (creating it earlier would violate the constraint).
    if (!prev) recordWorktree(repo.id, runId, worktreePath, branch);
    emitEvent("run.started", { cardId, runId, payload: { kind: "plan" } });

    const controller = new AbortController();
    deps.registerController(runId, controller);
    // The awaited git calls above open a window where the user can cancel
    // before this run row existed — never start a harness for such a card.
    if (deps.getCard(cardId)?.status !== "planning") {
      deps.finishRun(runId, "cancelled", "card left planning before the run started");
      deps.releaseController(runId);
      await ctx.cleanup();
      return;
    }
    const prevPlan = deps.latestPlan(cardId);
    try {
      // Circuit breaker: a provider with recent connection/auth failures
      // fails this run fast instead of repeating the same slow failure.
      if (isProviderOpen(plannerProvider)) {
        const reason = `provider ${plannerProvider} circuit breaker open — recent connection failures, will retry automatically after cooldown`;
        deps.finishRun(runId, "failed", reason);
        deps.moveCard(cardId, "planning", "needs_attention", reason);
        return;
      }
      // Live transcript push (Phase 16 chunk A) — single-file transcripts
      // (plan/evaluate) always use iteration 0, matching the `singleFile`
      // convention in /api/runs/[id]'s route and the TranscriptTarget the
      // card page builds for a non-loop run.
      const planTranscriptPath = path.join(runTranscriptDir(runId), "plan.jsonl");
      const stopTranscriptPush = startTranscriptPush(planTranscriptPath, runId, 0);
      let result;
      try {
        result = await runHarness({
          provider: plannerProvider,
          model: plannerModel,
          reasoningLevel: settings.plannerReasoningLevel,
          prompt: renderPlanPrompt(
            settings.plannerPromptTemplate,
            card.title,
            card.description,
            prevPlan?.feedback ?? undefined,
          ),
          cwd: worktreePath,
          transcriptPath: planTranscriptPath,
          timeoutMs: settings.plannerTimeoutMinutes * 60 * 1000,
          signal: controller.signal,
          role: "planner",
          runContext: ctx,
        });
      } finally {
        stopTranscriptPush();
      }

      if (controller.signal.aborted) return; // cancelCard already finalized

      if (result.timedOut) {
        deps.finishRun(runId, "timeout", "planning timed out", runTelemetry(result));
        deps.moveCard(cardId, "planning", "needs_attention", "planning timed out");
        return;
      }
      // A dead stream, not a slow planner — worth its own reason so it isn't
      // read as the model failing to produce a plan.
      if (result.stalled) {
        deps.finishRun(
          runId,
          "failed",
          `planner stalled: ${result.error.slice(0, 500)}`,
          runTelemetry(result),
        );
        deps.moveCard(cardId, "planning", "needs_attention", "planner stalled");
        return;
      }
      if (result.error) {
        if (CONN_ERROR_PATTERN.test(result.error)) recordProviderOutcome(plannerProvider, false);
        deps.finishRun(
          runId,
          "failed",
          `planner failed: ${result.error.slice(0, 500)}`,
          runTelemetry(result),
        );
        deps.moveCard(cardId, "planning", "needs_attention", "planner failed");
        return;
      }
      recordProviderOutcome(plannerProvider, true);

      // Check for the planner's follow-up questions escape hatch.
      const questionsPath = path.join(
        /* turbopackIgnore: true */ worktreePath,
        ".ralph",
        "QUESTIONS.md",
      );
      const questions = fs.existsSync(/* turbopackIgnore: true */ questionsPath)
        ? fs.readFileSync(/* turbopackIgnore: true */ questionsPath, "utf8").trim()
        : "";
      if (questions) {
        await tryGit(worktreePath, "add", ".ralph");
        await tryGit(worktreePath, "commit", "-m", `ralph: planner raised questions for "${card.title}"`);
        emitEvent("plan.questions", { cardId, runId, payload: { questions } });
        deps.finishRun(runId, "completed", "planner raised follow-up questions", runTelemetry(result));
        deps.moveCard(cardId, "planning", "needs_attention", "planner has follow-up questions");
        return;
      }

      // Read the three artifacts the planner must have written.
      const contents: Record<string, string> = {};
      for (const f of RALPH_FILES) {
        const p = path.join(/* turbopackIgnore: true */ worktreePath, ".ralph", f);
        contents[f] = fs.existsSync(/* turbopackIgnore: true */ p)
          ? fs.readFileSync(/* turbopackIgnore: true */ p, "utf8").trim()
          : "";
      }
      if (RALPH_FILES.some((f) => !contents[f])) {
        deps.finishRun(
          runId,
          "failed",
          "planner produced malformed artifacts",
          runTelemetry(result),
        );
        deps.moveCard(cardId, "planning", "needs_attention", "planner produced malformed artifacts");
        return;
      }
      // The checklist must parse and hold at least one unchecked task —
      // there is no fallback prompt, so an unparseable plan cannot run.
      if (!firstUnchecked(contents["PLAN.md"])) {
        const reason = "plan checklist unparseable or has no unchecked tasks";
        deps.finishRun(runId, "failed", reason, runTelemetry(result));
        deps.moveCard(cardId, "planning", "needs_attention", reason);
        return;
      }

      const version = (prevPlan?.version ?? 0) + 1;
      const planId = nanoid();
      db.insert(plans)
        .values({
          id: planId,
          cardId,
          version,
          planMd: contents["PLAN.md"],
          promptMd: contents["PROMPT.md"],
          acceptanceCriteria: contents["CRITERIA.md"],
          createdAt: now(),
        })
        .run();
      db.update(runs).set({ planId }).where(eq(runs.id, runId)).run();
      emitEvent("plan.created", { cardId, runId, payload: { version } });

      // PLAN.md and CRITERIA.md are orchestrator-private: remove them from the
      // worktree before the plan commit so the loop agent can never read them —
      // not in the working tree and not in the branch history. Their content is
      // preserved above (PLAN.md in the private state file, CRITERIA.md in the
      // plan row's acceptanceCriteria, injected into the evaluator's prompt).
      const statePath = planStatePath(cardId);
      fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(statePath), { recursive: true });
      fs.writeFileSync(/* turbopackIgnore: true */ statePath, contents["PLAN.md"]);
      for (const privateFile of ["PLAN.md", "CRITERIA.md"]) {
        fs.rmSync(
          path.join(/* turbopackIgnore: true */ worktreePath, ".ralph", privateFile),
          { force: true },
        );
      }

      await tryGit(worktreePath, "add", ".ralph");
      await tryGit(worktreePath, "commit", "-m", `ralph: plan v${version} for "${card.title}"`);

      deps.finishRun(runId, "completed", "plan artifacts written", runTelemetry(result));
      deps.moveCard(cardId, "planning", planningDestination(card));
    } finally {
      deps.releaseController(runId);
      await ctx.cleanup();
      // The pipeline slot just freed: loop the newly-ready card, or plan the
      // next Todo card when this one stopped for plan review / an error.
      deps.pump();
    }
  }
}
