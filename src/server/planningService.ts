import fs from "node:fs";
import path from "node:path";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, now, plans, runs, reviews, type PlanOrigin, type ScopingRole } from "@/db";
import { emitEvent } from "./events";
import { addScopingMessage, listScopingMessages, type ScopingMessage } from "./scoping";
import { LOOP_BLOCKED_EXIT, REPLAN_LOOP_EXITS } from "@/shared/failedStep";
import { errorMessage } from "@/shared/errorMessage";
import { getSettings } from "./settings";
import {
  ensureRalphDir,
  planStatePath,
  readRalphArtifact,
  removeRalphFiles,
} from "./bookkeeping";
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
  precheckAcceptance,
  precheckReviseFeedback,
  PRECHECK_REVISE_EXIT,
} from "./acceptanceProbe";
import {
  criticEnabled,
  consecutivePlanRevisions,
  MAX_CRITIC_REVISIONS,
} from "./planCriticService";
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
  return readRalphArtifact(worktreePath, name).trim();
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

const CRITIC_REVISE_PREFIX =
  "The plan critic reviewed the previous plan before any code was written and asked for changes:\n\n";

/** What the planner re-plans from when the acceptance pre-check found a check
 * that already passes on the untouched worktree. Such a check cannot show the
 * work this card is for, so the instruction is to rewrite the check — never a
 * claim that the plan itself was found wrong. */
const PRECHECK_REVISE_PREFIX =
  "The acceptance pre-check ran the plan's check commands against the untouched worktree before any work was done and asked for changes:\n\n";

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
  // Replacer functions, not strings: a string replacement expands `$&`, `` $` ``
  // and `$'` in the value into the surrounding prompt, and plans do contain
  // those sequences: a bcrypt hash, a regex anchor before a closing quote.
  return withScoping
    .replaceAll("{{TITLE}}", () => title)
    .replaceAll("{{DESCRIPTION}}", () => description || "(no description)")
    .replaceAll("{{SCOPING_SECTION}}", () => scopingSection)
    .replaceAll("{{FEEDBACK_SECTION}}", () => feedbackSection);
}

/**
 * Feedback the planner has not re-planned from yet: a human rejection of the
 * diff, an evaluator `revise` verdict, a plan critic `revise` verdict
 * (spec 30), or the acceptance pre-check sending the plan back for a check
 * that already passed on the untouched worktree (spec 31).
 *
 * Each of these sends the card back through planning rather than straight to the loop,
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
  const reviseRow = db
    .select({ feedback: runs.feedback, kind: runs.kind, at: runs.startedAt })
    .from(runs)
    .where(and(onLatestPlan, inArray(runs.kind, ["evaluate", "critique"]), eq(runs.exitReason, "revise")))
    .orderBy(desc(runs.startedAt))
    .limit(1)
    .get();
  // The critic judged the plan alone, before any code existed: say so, or the
  // planner reads its feedback as a review of an implementation.
  const revise =
    reviseRow?.kind === "critique" && reviseRow.feedback
      ? { ...reviseRow, feedback: CRITIC_REVISE_PREFIX + reviseRow.feedback }
      : reviseRow;
  // The pre-check's verdict belongs to the plan rather than to any code: the
  // commands it ran passed before the card had changed anything, so a check
  // like that cannot show the work this card is for.
  const precheckRow = db
    .select({ feedback: runs.feedback, at: runs.startedAt })
    .from(runs)
    .where(
      and(
        onLatestPlan,
        eq(runs.kind, "plan"),
        eq(runs.exitReason, PRECHECK_REVISE_EXIT),
        isNotNull(runs.feedback),
      ),
    )
    .orderBy(desc(runs.startedAt))
    .limit(1)
    .get();
  const precheck = precheckRow?.feedback
    ? { feedback: PRECHECK_REVISE_PREFIX + precheckRow.feedback, at: precheckRow.at }
    : null;
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
    precheck,
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
  opts: {
    origin: PlanOrigin;
    feedback?: string | null;
    runId?: string;
    /** Spec 31: the pre-check's already-passing commands, recorded so the
     * post-DONE probe can report them without repairing them. */
    precheckPassing?: string[];
  },
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
      // Given-but-empty is its own answer (nothing already passed), so this is
      // an `undefined` test rather than a truthiness one.
      precheckPassing:
        opts.precheckPassing === undefined ? null : JSON.stringify(opts.precheckPassing),
      createdAt: now(),
    })
    .run();
  emitEvent("plan.created", { cardId, runId: opts.runId, payload: { version, origin: opts.origin } });

  const statePath = planStatePath(cardId);
  fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(statePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(/* turbopackIgnore: true */ path.dirname(statePath), 0o700);
  fs.writeFileSync(/* turbopackIgnore: true */ statePath, artifacts.planMd, { mode: 0o600 });
  fs.chmodSync(/* turbopackIgnore: true */ statePath, 0o600);
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
  constructor(
    private readonly deps: StageDependencies & {
      pump(): void;
      /** Spec 30: hand a finished plan to the critic; the card stays in `planning`. */
      critique(cardId: string): void;
      /** Spec 31: run the planner again on a card still in `planning` — what
       * the acceptance pre-check does with a plan whose checks already pass. */
      replan(cardId: string): void;
    },
  ) {}

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
    ensureRalphDir(worktreePath);
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
    /** Still ours to finish: not cancelled, and the run row is still `running`
     * rather than something `cancelCard` (or the reaper) already wrote.
     * Spec 31's pre-check runs shell commands, which takes real time, so this
     * is read after each of the awaits that follow — writing a plan row or
     * moving a card for a dead run would resurrect it. */
    const active = () =>
      !controller.signal.aborted &&
      db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).get()?.status ===
      "running";
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

      // Spec 31: run the plan's own check commands against the worktree as it
      // stands, before any iteration exists. A check that already exits the way
      // its criterion wants will still exit that way if this card changes
      // nothing, so it cannot evidence the work — one bounded replan now costs
      // far less than a whole loop plus an evaluation. What this is NOT: a
      // judgment on the plan. The probe is one-sided (see acceptanceProbe.ts),
      // so `failing` here is the healthy expected outcome for new behaviour and
      // nothing here says a criterion is met.
      const report = await precheckAcceptance({
        acceptanceCriteria: contents["CRITERIA.md"],
        worktreePath,
        ctx,
        signal: controller.signal,
      });
      // The checks took wall-clock time; a cancel landing inside them has
      // already finalized this run and moved the card.
      if (!active()) return;

      // A criteria document with no runnable command at all has nothing to
      // report — no event, and no `precheckPassing` column either, so the row
      // stays distinguishable from "checked, and nothing passed". Regression
      // commands count as seen even though none of them ran.
      const probed = report.checked + report.skipped.length > 0;

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
        {
          origin: "planner",
          feedback: replanFeedback,
          runId,
          // Recorded on the plan row so the post-DONE probe can report these
          // without spending a repair iteration on them.
          precheckPassing: probed ? report.alreadyPassing : undefined,
        },
      );
      db.update(runs).set({ planId }).where(eq(runs.id, runId)).run();

      // Exactly one replan per plan: `precheck === 0` bounds it to the first
      // pre-check finding, and the cap the critic shares (spec 30) bounds the
      // ping-pong. Past either, the plan ships as written and the finding stays
      // in the event — the loop and the evaluator still get their say.
      let revise = false;
      if (probed) {
        const { critic, precheck } = consecutivePlanRevisions(cardId);
        revise =
          report.alreadyPassing.length > 0 &&
          precheck === 0 &&
          critic + precheck < MAX_CRITIC_REVISIONS;
        emitEvent("acceptance.precheck", {
          cardId,
          runId,
          payload: {
            version,
            checked: report.checked,
            alreadyPassingCount: report.alreadyPassing.length,
            skippedCount: report.skipped.length,
            alreadyPassing: report.alreadyPassing,
            failing: report.failing,
            unprobed: report.unprobed,
            skipped: report.skipped,
            revise,
          },
        });
      }

      removeRalphFiles(worktreePath, ["PLAN.md", "CRITERIA.md"]);

      await tryGit(worktreePath, "add", ".ralph");
      await tryGit(worktreePath, "commit", "-m", `ralph: plan v${version} for "${card.title}"`);
      // Two git awaits: the same cancellation window, after the commit this
      // time. The artifacts are written either way; only the routing below is
      // the dead run's to skip.
      if (!active()) return;

      if (revise) {
        // The feedback rides on THIS run and is read back by the next planning
        // run through `pendingReplanFeedback`, which finds it by this exit
        // reason. Set it before finishing, or the row is finished unread.
        db.update(runs)
          .set({ feedback: precheckReviseFeedback(report.alreadyPassing) })
          .where(eq(runs.id, runId))
          .run();
        if (!deps.finishRun(runId, "completed", PRECHECK_REVISE_EXIT, telemetry)) return;
        emitEvent("plan.precheck_revise_requested", {
          cardId,
          runId,
          payload: { version, alreadyPassing: report.alreadyPassing },
        });
        // Like a critic revise verdict: the card never left `planning`, so it
        // keeps its pipeline slot straight into the re-plan.
        deps.replan(cardId);
        return;
      }

      if (!deps.finishRun(runId, "completed", "plan artifacts written", telemetry)) return;
      if (criticEnabled(card, settings)) {
        // Spec 30: the critic reads the plan while the card keeps its slot in
        // `planning`; it moves the card on (or re-plans) itself.
        emitEvent("plan.critique_requested", { cardId, runId, payload: { version } });
        deps.critique(cardId);
      } else {
        deps.moveCard(cardId, "planning", planningDestination(card));
      }
    } catch (error) {
      // Cancellation first, before anything else: `cancelCard` has already
      // finished this row and routed the card, and re-finishing it here would
      // overwrite the status the user cancelled into.
      if (controller.signal.aborted) return;
      const reason = `planner failed: ${errorMessage(error)}`;
      // A false return means somebody else closed the row while this run was
      // throwing — a peer, the reaper. Its routing stands; moving the card now
      // would pull it back out of wherever that left it.
      if (!deps.finishRun(runId, "failed", reason.slice(0, 500), telemetry)) return;
      if (deps.getCard(cardId)?.status === "planning") {
        deps.moveCard(cardId, "planning", "needs_attention", reason);
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
