import fs from "node:fs";
import path from "node:path";
import { and, desc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, now, plans, runs, reviews, type PlanOrigin, type ScopingRole } from "@/db";
import { emitEvent } from "./events";
import { addScopingMessage, listScopingMessages, type ScopingMessage } from "./scoping";
import { LOOP_BLOCKED_EXIT, REPLAN_LOOP_EXITS } from "@/shared/failedStep";
import { errorMessage } from "@/shared/errorMessage";
import { getSettings } from "./settings";
import { planStatePath, ralphDirPath, readFileIfExists, removeRalphFiles } from "./bookkeeping";
import {
  attemptTranscriptPath,
  digestTranscript,
  previousFailedAttempt,
  renderDeadlineSection,
  renderPreviousAttemptSection,
} from "./previousAttempt";
import { firstUnchecked } from "./checklist";
import { runTelemetry, type RunTelemetry } from "./harness";
import { normalizeProvider } from "./providers";
import { offRunBranchReason, tryGit } from "./git";
import { getRepo } from "./repos";
import { createRunSandbox } from "./sandbox/context";
import {
  circuitOpenReason,
  harnessFailure,
  resolveWorktree,
  runWithTranscript,
  startRunRow,
  type FinishStatus,
  type StageDependencies,
} from "./stage";

const RALPH_FILES = ["PLAN.md", "CRITERIA.md", "PROMPT.md"] as const;
const PLANNER_FILES = ["QUESTIONS.md", ...RALPH_FILES] as const;

function readRalphFile(worktreePath: string, name: string): string {
  return readFileIfExists(path.join(/* turbopackIgnore: true */ ralphDirPath(worktreePath), name)).trim();
}

/** Planner retries intentionally reuse a worktree, but never another
 * attempt's output. Each invocation must earn a complete artifact set. */
export function clearPlannerArtifacts(worktreePath: string) {
  removeRalphFiles(worktreePath, PLANNER_FILES);
}

/** The three artifacts are present and PLAN.md has a task to run: what a
 * completed planning run must leave, and what a killed one may have. */
function plannerArtifactsComplete(worktreePath: string): boolean {
  const contents = RALPH_FILES.map((f) => readRalphFile(worktreePath, f));
  return contents.every(Boolean) && firstUnchecked(contents[0]) !== null;
}

const SCOPING_SPEAKER: Record<ScopingRole, string> = {
  user: "Operator",
  assistant: "Scoping assistant",
  planner: "Planner (an earlier planning run)",
  loop: "Implementation loop (blocked)",
};

/** What the planner re-plans from when the loop stopped for it rather than
 * for a retry: the blocker it reported, or a checklist it ticked off without
 * ever signalling DONE. Either way the work so far is on the branch. */
function loopStopFeedback(exitReason: string, feedback: string | null): string {
  if (exitReason === LOOP_BLOCKED_EXIT) {
    return (
      "The implementation loop stopped on a blocker outside its control:\n\n" +
      (feedback ?? "(no detail recorded)") +
      "\n\nPlan around it. The loop runs sandboxed — no network beyond package registries, " +
      "no credentials, no logged-in sessions, nobody to ask — so do not give it a task that " +
      "needs what it does not have. Leave what only the operator can do to the operator, and " +
      "say so in PLAN.md. The scoping thread holds the operator's answers, if any."
    );
  }
  return (
    "Every checklist item was ticked, but the loop never signalled DONE, so the final task's " +
    "own check did not pass. Plan the work still needed on top of the code already on this " +
    "branch. The scoping thread holds anything the operator added since."
  );
}

export function renderPlanPrompt(
  template: string,
  title: string,
  description: string,
  feedback?: string,
  scoping: Pick<ScopingMessage, "role" | "content">[] = [],
) {
  const feedbackSection = feedback
    ? `\nPREVIOUS ATTEMPT — REVIEWER FEEDBACK\n====================================\n${feedback}\n\nThe working directory already holds the previous attempt's implementation,\ncommitted on this branch. Plan only the work needed to address the feedback\nabove on top of that code — do not re-plan tasks it already satisfies.\n`
    : "";
  // Spec 17: the thread is part of the card, so the planner gets it whole and
  // the decisions reached there constrain the plan. Questions an earlier
  // planning run raised appear with the operator's answers under them.
  const scopingSection = scoping.length
    ? `\nSCOPING THREAD\n==============\nThe operator scoped this card in conversation before planning. Decisions\nreached below are part of the card; where they and the description disagree,\nthe thread is the newer of the two.\n\n${scoping.map((m) => `${SCOPING_SPEAKER[m.role]}: ${m.content}`).join("\n\n")}\n`
    : "";
  // A template customized before this placeholder existed still gets the
  // thread, right after the description, rather than silently losing it.
  const withScoping = template.includes("{{SCOPING_SECTION}}")
    ? template
    : template.replace("{{DESCRIPTION}}", "{{DESCRIPTION}}\n{{SCOPING_SECTION}}");
  return withScoping
    .replaceAll("{{TITLE}}", title)
    .replaceAll("{{DESCRIPTION}}", description || "(no description)")
    .replaceAll("{{SCOPING_SECTION}}", scopingSection)
    .replaceAll("{{FEEDBACK_SECTION}}", feedbackSection);
}

/**
 * Feedback the planner has not re-planned from yet: a human rejection of the
 * diff, or an evaluator `revise` verdict.
 *
 * Both send the card back through planning rather than straight to the loop,
 * so pending feedback is also what tells `startCard` to re-plan a card that
 * already has a plan. "Pending" means the feedback was given on the card's
 * latest plan — once the planner writes a new version, it is spent.
 */
export function pendingReplanFeedback(cardId: string): string | null {
  const latest = db
    .select({ id: plans.id })
    .from(plans)
    .where(eq(plans.cardId, cardId))
    .orderBy(desc(plans.version))
    .limit(1)
    .get();
  if (!latest) return null;
  const onLatestPlan = and(eq(runs.cardId, cardId), eq(runs.planId, latest.id));
  const rejection = db
    .select({ feedback: reviews.feedback, at: reviews.createdAt })
    .from(reviews)
    .innerJoin(runs, eq(reviews.runId, runs.id))
    .where(and(onLatestPlan, eq(reviews.decision, "rejected")))
    .orderBy(desc(reviews.createdAt))
    .limit(1)
    .get();
  const revise = db
    .select({ feedback: runs.feedback, at: runs.startedAt })
    .from(runs)
    .where(and(onLatestPlan, eq(runs.kind, "evaluate"), eq(runs.exitReason, "revise")))
    .orderBy(desc(runs.startedAt))
    .limit(1)
    .get();
  // A loop that stopped for the planner: blocked, or exhausted without DONE.
  // Older exhausted rows carry no feedback of their own, so the wording is
  // supplied here rather than read from the row.
  const loopStop = db
    .select({ feedback: runs.feedback, exitReason: runs.exitReason, at: runs.startedAt })
    .from(runs)
    .where(and(onLatestPlan, eq(runs.kind, "loop"), inArray(runs.exitReason, [...REPLAN_LOOP_EXITS])))
    .orderBy(desc(runs.startedAt))
    .limit(1)
    .get();
  const newest = [
    rejection,
    revise,
    loopStop && { feedback: loopStopFeedback(loopStop.exitReason!, loopStop.feedback), at: loopStop.at },
  ]
    .filter((row) => row?.feedback)
    .sort((a, b) => b!.at.localeCompare(a!.at))[0];
  return newest?.feedback ?? null;
}

/**
 * Persist one plan version and make it the card's private checklist.
 *
 * Shared by the planning run below and by a scoping session that authored the
 * plan itself (spec 17), so the version numbering, the `plan.created` event
 * and the private PLAN.md all happen in one place regardless of which role
 * wrote the artifacts. Returns the new plan's id.
 *
 * The private state file is overwritten, not merged: a new plan version is a
 * new checklist, and its ticks start empty. That is the opposite of the
 * loop's own re-entry, which must never clobber the ticks it has earned
 * (see `startLoop`).
 */
export function writePlanRow(
  cardId: string,
  artifacts: { planMd: string; promptMd: string; acceptanceCriteria: string },
  opts: { origin: PlanOrigin; feedback?: string | null; runId?: string },
): { planId: string; version: number } {
  const previous = db
    .select({ version: plans.version })
    .from(plans)
    .where(eq(plans.cardId, cardId))
    .orderBy(desc(plans.version))
    .get();
  const version = (previous?.version ?? 0) + 1;
  const planId = nanoid();
  db.insert(plans)
    .values({
      id: planId,
      cardId,
      version,
      planMd: artifacts.planMd,
      promptMd: artifacts.promptMd,
      acceptanceCriteria: artifacts.acceptanceCriteria,
      feedback: opts.feedback ?? null,
      origin: opts.origin,
      createdAt: now(),
    })
    .run();
  emitEvent("plan.created", { cardId, runId: opts.runId, payload: { version, origin: opts.origin } });

  const statePath = planStatePath(cardId);
  fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(statePath), { recursive: true });
  fs.writeFileSync(/* turbopackIgnore: true */ statePath, artifacts.planMd);
  return { planId, version };
}

/** Opted-in cards pause for human plan review; ordinary cards go straight to ready. */
export function planningDestination(
  card: { reviewPlanBeforeImplementation: number }
): "plan_review" | "ready" {
  return card.reviewPlanBeforeImplementation ? "plan_review" : "ready";
}

/**
 * Owns the planning run: worktree setup, the planner harness invocation, and
 * artifact validation. Queue scheduling and run/card state stay behind
 * injected callbacks.
 */
export class PlanningService {
  constructor(private readonly deps: StageDependencies & { pump(): void }) {}

  async runPlanning(cardId: string) {
    const deps = this.deps;
    const card = deps.getCard(cardId)!;
    const repo = getRepo(card.repoId);
    if (!repo) throw new Error("repo not found");
    const settings = getSettings();

    const runId = nanoid();
    const provider = normalizeProvider(settings.plannerProvider, "anthropic");
    const model = card.plannerModel || settings.plannerModel;
    const { worktreePath, branch, baseBranch, created } = await resolveWorktree(
      repo, card, runId, deps.latestWorktreeRun(cardId),
    );
    // Spec 26: a retry inherits the attempt it retries, drafts included.
    // Decided before this run's row exists, since the rule reads the card's
    // latest run, and before the clear below removes what it left.
    const previous = previousFailedAttempt(cardId, "plan");
    const drafts = previous
      ? Object.fromEntries(RALPH_FILES.map((f) => [f, readRalphFile(worktreePath, f)]))
      : undefined;
    clearPlannerArtifacts(worktreePath);
    // Spec 14 Phase 3: the planner's ONLY L2 write root is the worktree's
    // `.ralph/` — ensure it exists so the write root resolves.
    fs.mkdirSync(/* turbopackIgnore: true */ ralphDirPath(worktreePath), { recursive: true });
    const ctx = await createRunSandbox(runId);
    startRunRow(
      { id: runId, cardId, kind: "plan", worktreePath, branch, baseBranch, provider, model, workerId: deps.workerId() },
      ctx,
      settings,
      created ? repo.id : undefined,
    );
    emitEvent("run.started", { cardId, runId, payload: { kind: "plan" } });

    const controller = new AbortController();
    deps.registerController(runId, controller);
    let telemetry: RunTelemetry | undefined;
    const fail = (exitReason: string, moveReason = exitReason, status: FinishStatus = "failed") => {
      deps.finishRun(runId, status, exitReason, telemetry);
      deps.moveCard(cardId, "planning", "needs_attention", moveReason);
    };
    // The awaited git calls above open a window where the user can cancel
    // before this run row existed — never start a harness for such a card.
    if (deps.getCard(cardId)?.status !== "planning") {
      deps.finishRun(runId, "cancelled", "card left planning before the run started");
      deps.releaseController(runId);
      await ctx.cleanup();
      return;
    }
    const prevPlan = deps.latestPlan(cardId);
    const replanFeedback = pendingReplanFeedback(cardId);
    try {
      const breaker = circuitOpenReason(provider);
      if (breaker) return fail(breaker);

      // Spec 26: the killed attempt's drafts and command digest, then the
      // clock, appended outside the template so a customized one still gets them.
      let previousSection = "";
      if (previous) {
        const digest = digestTranscript(attemptTranscriptPath(previous));
        previousSection = renderPreviousAttemptSection({ stage: "planner", attempt: previous, digest, drafts });
        emitEvent("attempt.forwarded", {
          cardId,
          runId,
          payload: { kind: "plan", previousRunId: previous.runId, toolCalls: digest.toolCalls },
        });
      }
      const timeoutMs = settings.plannerTimeoutMinutes * 60 * 1000;
      const prompt =
        renderPlanPrompt(
          settings.plannerPromptTemplate,
          card.title,
          card.description,
          replanFeedback ?? prevPlan?.feedback ?? undefined,
          listScopingMessages(cardId),
        ) +
        previousSection +
        renderDeadlineSection("planner", new Date(), timeoutMs);
      const result = await runWithTranscript({
        runId,
        file: "plan.jsonl",
        provider,
        model,
        reasoningLevel: settings.plannerReasoningLevel,
        prompt,
        cwd: worktreePath,
        timeoutMs,
        signal: controller.signal,
        role: "planner",
        runContext: ctx,
      });
      if (controller.signal.aborted) return; // cancelCard already finalized

      telemetry = runTelemetry(result);
      // Spec 26 decision 4: complete artifacts on disk outlive the watchdog
      // that killed the session (spec 18 item 1 for the planner). Every
      // check below still applies to them.
      const recovered = (result.timedOut || result.stalled) && plannerArtifactsComplete(worktreePath);
      if (recovered) {
        emitEvent("plan.recovered_after_timeout", {
          cardId,
          runId,
          payload: { cause: result.timedOut ? "timeout" : "stalled" },
        });
      } else {
        const failure = harnessFailure(result, provider, "planner");
        if (failure) return fail(failure.exitReason, failure.moveReason, failure.status);
      }

      // Both commits below land in this worktree. The planner itself has no
      // bash and writes only `.ralph/`, but a worktree reused from an earlier
      // loop run may already have been moved off its branch or repointed.
      const offBranch = await offRunBranchReason(worktreePath, branch, repo.path);
      if (offBranch) return fail(offBranch);

      // The planner's follow-up questions escape hatch.
      const questions = readRalphFile(worktreePath, "QUESTIONS.md");
      if (questions) {
        await tryGit(worktreePath, "add", ".ralph");
        await tryGit(worktreePath, "commit", "-m", `ralph: planner raised questions for "${card.title}"`);
        emitEvent("plan.questions", { cardId, runId, payload: { questions } });
        // Spec 17: the questions join the card's scoping thread, where the
        // operator answers them; the next planning run reads the whole thread.
        addScopingMessage(cardId, "planner", questions);
        deps.finishRun(runId, "completed", "planner raised follow-up questions", telemetry);
        deps.moveCard(cardId, "planning", "needs_attention", "planner has follow-up questions");
        return;
      }

      const contents = Object.fromEntries(
        RALPH_FILES.map((f) => [f, readRalphFile(worktreePath, f)]),
      ) as Record<(typeof RALPH_FILES)[number], string>;
      if (RALPH_FILES.some((f) => !contents[f])) {
        return fail("planner produced malformed artifacts");
      }
      // There is no fallback prompt, so an unparseable plan cannot run.
      if (!firstUnchecked(contents["PLAN.md"])) {
        return fail("plan checklist unparseable or has no unchecked tasks");
      }

      // PLAN.md and CRITERIA.md are orchestrator-private: remove them before
      // the plan commit so the loop agent can never read them — not in the
      // working tree and not in branch history. PLAN.md lives on in the
      // private state file, CRITERIA.md in the plan row.
      const { planId, version } = writePlanRow(
        cardId,
        {
          planMd: contents["PLAN.md"],
          promptMd: contents["PROMPT.md"],
          acceptanceCriteria: contents["CRITERIA.md"],
        },
        { origin: "planner", feedback: replanFeedback, runId },
      );
      db.update(runs).set({ planId }).where(eq(runs.id, runId)).run();
      removeRalphFiles(worktreePath, ["PLAN.md", "CRITERIA.md"]);

      await tryGit(worktreePath, "add", ".ralph");
      await tryGit(worktreePath, "commit", "-m", `ralph: plan v${version} for "${card.title}"`);

      deps.finishRun(runId, "completed", "plan artifacts written", telemetry);
      deps.moveCard(cardId, "planning", planningDestination(card));
    } catch (error) {
      if (!controller.signal.aborted) {
        const reason = `planner failed: ${errorMessage(error)}`;
        deps.finishRun(runId, "failed", reason.slice(0, 500), telemetry);
        if (deps.getCard(cardId)?.status === "planning") {
          deps.moveCard(cardId, "planning", "needs_attention", reason);
        }
      }
    } finally {
      deps.releaseController(runId);
      await ctx.cleanup();
      // The pipeline slot just freed: loop the newly-ready card, or plan the
      // next Todo card when this one stopped for plan review / an error.
      deps.pump();
    }
  }
}
