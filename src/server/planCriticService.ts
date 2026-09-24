import fs from "node:fs";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, runs, type ScopingRole } from "@/db";
import { emitEvent } from "./events";
import { getSettings } from "./settings";
import { ralphDirPath, readFileIfExists, removeRalphFiles } from "./bookkeeping";
import { renderDeadlineSection } from "./previousAttempt";
import { parseEvaluation } from "@/shared/evaluation";
import { changedPaths } from "@/shared/docPaths";
import { errorMessage } from "@/shared/errorMessage";
import { runTelemetry, type RunTelemetry } from "./harness";
import { normalizeProvider } from "./providers";
import { offRunBranchReason, tryGit } from "./git";
import { getRepo } from "./repos";
import { createRunSandbox } from "./sandbox/context";
import { listScopingMessages, type ScopingMessage } from "./scoping";
import { planningDestination } from "./planningService";
import {
  circuitOpenReason,
  harnessFailure,
  runWithTranscript,
  startRunRow,
  type FinishStatus,
  type StageDependencies,
} from "./stage";

/** After this many consecutive revise verdicts the critic stops sending the
 * plan back and escalates to human plan review — a critic and a planner must
 * not ping-pong forever. */
const MAX_CRITIC_REVISIONS = 2;

/** Where the critic writes its verdict, relative to the worktree's .ralph/. */
export const CRITIQUE_FILE = "CRITIQUE.md";

/**
 * Spec 30: whether a card's plan goes through the critic. A per-card override
 * (`planCritic` 1/0) wins outright; otherwise the workspace mode decides —
 * `always`, `breakdown` (only cards produced by a breakdown, i.e. with a
 * parent), or `off`.
 */
export function criticEnabled(
  card: { planCritic: number | null; parentCardId: string | null },
  settings: { planCriticMode: string },
): boolean {
  if (card.planCritic !== null) return Boolean(card.planCritic);
  if (settings.planCriticMode === "always") return true;
  if (settings.planCriticMode === "breakdown") return card.parentCardId !== null;
  return false;
}

/** Spec file paths (`specs/<name>.md`) named anywhere in the given texts,
 * unique and in order of first appearance. */
export function namedSpecFiles(...texts: string[]): string[] {
  const seen = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(/\bspecs\/[\w.-]+\.md\b/g)) {
      seen.add(match[0]);
    }
  }
  return [...seen];
}

// Same speaker names the planner sees, so the critic reads the thread the
// way the plan it is judging was written from.
const SCOPING_SPEAKER: Record<ScopingRole, string> = {
  user: "Operator",
  assistant: "Scoping assistant",
  planner: "Planner (an earlier planning run)",
  loop: "Implementation loop (blocked)",
};

const CRITIQUE_PATH = `.ralph/${CRITIQUE_FILE}`;

export function renderCriticPrompt(
  template: string,
  input: {
    title: string;
    description: string;
    scoping: Pick<ScopingMessage, "role" | "content">[];
    specFiles: string[];
    planVersion: number;
    planMd: string;
    criteriaMd: string;
    promptMd: string;
  },
): string {
  const scopingSection = input.scoping.length
    ? `\nSCOPING THREAD\n==============\nThe operator scoped this card in conversation before planning. Decisions\nreached below are part of the card; where they and the description disagree,\nthe thread is the newer of the two.\n\n${input.scoping.map((m) => `${SCOPING_SPEAKER[m.role]}: ${m.content}`).join("\n\n")}\n`
    : "";
  const specFiles = input.specFiles.length
    ? input.specFiles.join("\n")
    : "(the card names no spec files)";
  const rendered = template
    .replaceAll("{{TITLE}}", input.title)
    .replaceAll("{{DESCRIPTION}}", input.description || "(no description)")
    .replaceAll("{{SCOPING_SECTION}}", scopingSection)
    .replaceAll("{{SPEC_FILES}}", specFiles)
    .replaceAll("{{PLAN_VERSION}}", String(input.planVersion))
    .replaceAll("{{PLAN_MD}}", input.planMd)
    .replaceAll("{{CRITERIA_MD}}", input.criteriaMd)
    .replaceAll("{{PROMPT_MD}}", input.promptMd);
  // A customized template that forgot the verdict file would leave the stage
  // with nothing to parse, so the instruction is guaranteed rather than trusted.
  return rendered.includes(CRITIQUE_PATH)
    ? rendered
    : `${rendered}\nWrite your verdict to ${CRITIQUE_PATH} and nothing else.\n`;
}

/**
 * How many times in a row the critic has sent the card's plan back since the
 * loop last ran — the count the revision cap is measured against. A loop run
 * resets it: revisions before the latest loop belong to an earlier cycle.
 */
export function consecutiveCriticRevisions(cardId: string): number {
  const latestLoop = db
    .select({ startedAt: runs.startedAt })
    .from(runs)
    .where(and(eq(runs.cardId, cardId), eq(runs.kind, "loop")))
    .orderBy(desc(runs.startedAt))
    .limit(1)
    .get();
  const revisions = db
    .select({ startedAt: runs.startedAt })
    .from(runs)
    .where(and(eq(runs.cardId, cardId), eq(runs.kind, "critique"), eq(runs.exitReason, "revise")))
    .all();
  if (!latestLoop) return revisions.length;
  return revisions.filter((r) => r.startedAt > latestLoop.startedAt).length;
}

export type PlanCriticDependencies = StageDependencies & {
  /** Advance the repo's queue once this critique releases its slot. */
  pump(): void;
  /** Run the planner on a card still in `planning` — a revise verdict
   * re-plans with the critic's feedback attached. */
  replan(cardId: string): void;
};

/**
 * Spec 30 — the read-only plan critic. Between planning and the loop it reads
 * the plan against the card and its named specs, then writes a verdict to
 * `.ralph/CRITIQUE.md`: `approve` sends the card on to ready / plan review,
 * `revise` records the feedback on the run and re-plans. It never commits and
 * never touches anything but its verdict; a missing or malformed verdict, or
 * any other change, fails loudly to needs_attention.
 */
export class PlanCriticService {
  constructor(private readonly deps: PlanCriticDependencies) {}

  async runCritic(cardId: string) {
    const deps = this.deps;
    const card = deps.getCard(cardId)!;
    const repo = getRepo(card.repoId);
    if (!repo) throw new Error("repo not found");
    const plan = deps.latestPlan(cardId);
    if (!plan) throw new Error("card has no plan");
    const wt = deps.latestWorktreeRun(cardId);
    if (!wt) throw new Error("no worktree left to critique");
    const settings = getSettings();

    const runId = nanoid();
    const provider = normalizeProvider(settings.criticProvider, "anthropic");
    const model = card.criticModel || settings.criticModel;
    const { worktreePath, branch } = wt;
    const ralphDir = ralphDirPath(worktreePath);
    const verdictPath = path.join(/* turbopackIgnore: true */ ralphDir, CRITIQUE_FILE);

    // Like the planner: no bash, writes confined to `.ralph/`.
    const ctx = await createRunSandbox(runId);
    // A verdict left over from an earlier cycle must never be read as this run's.
    removeRalphFiles(worktreePath, [CRITIQUE_FILE]);
    fs.mkdirSync(/* turbopackIgnore: true */ ralphDir, { recursive: true });
    startRunRow(
      {
        id: runId,
        cardId,
        planId: plan.id,
        kind: "critique",
        worktreePath,
        branch,
        baseBranch: wt.baseBranch,
        provider,
        model,
        workerId: deps.workerId(),
      },
      ctx,
      settings,
    );
    emitEvent("run.started", { cardId, runId, payload: { kind: "critique" } });

    const controller = new AbortController();
    deps.registerController(runId, controller);
    let telemetry: RunTelemetry | undefined;
    const fail = (exitReason: string, moveReason = exitReason, status: FinishStatus = "failed") => {
      deps.finishRun(runId, status, exitReason, telemetry);
      deps.moveCard(cardId, "planning", "needs_attention", moveReason);
    };
    const head = async () => (await tryGit(worktreePath, "rev-parse", "HEAD")).out;
    const status = async () => (await tryGit(worktreePath, "status", "--porcelain")).out;
    try {
      // The awaited sandbox setup above opens a window where the user can
      // cancel before this run row existed — never start a harness for such a card.
      if (deps.getCard(cardId)?.status !== "planning") {
        deps.finishRun(runId, "cancelled", "card left planning before the run started");
        return;
      }
      const breaker = circuitOpenReason(provider);
      if (breaker) return fail(breaker);

      const headBefore = await head();
      const statusBefore = await status();

      const scoping = listScopingMessages(cardId);
      const timeoutMs = settings.criticTimeoutMinutes * 60 * 1000;
      const prompt =
        renderCriticPrompt(settings.criticPromptTemplate, {
          title: card.title,
          description: card.description,
          scoping,
          specFiles: namedSpecFiles(card.title, card.description, ...scoping.map((m) => m.content)),
          planVersion: plan.version,
          planMd: plan.planMd,
          criteriaMd: plan.acceptanceCriteria,
          promptMd: plan.promptMd,
        }) + renderDeadlineSection("critic", new Date(), timeoutMs);
      const result = await runWithTranscript({
        runId,
        file: "critique.jsonl",
        provider,
        model,
        reasoningLevel: settings.criticReasoningLevel,
        prompt,
        cwd: worktreePath,
        timeoutMs,
        signal: controller.signal,
        role: "critic",
        runContext: ctx,
      });
      if (controller.signal.aborted) return; // cancelCard already finalized
      telemetry = runTelemetry(result);

      // A complete verdict on disk outlives the watchdog that killed the
      // session (spec 26 decision 4). Every check below still applies to it.
      const recovered =
        (result.timedOut || result.stalled) && parseEvaluation(readFileIfExists(verdictPath)) !== null;
      if (recovered) {
        emitEvent("critique.recovered_after_timeout", {
          cardId,
          runId,
          payload: { cause: result.timedOut ? "timeout" : "stalled" },
        });
      } else {
        const failure = harnessFailure(result, provider, "critic");
        if (failure) return fail(failure.exitReason, failure.moveReason, failure.status);
      }

      const offBranch = await offRunBranchReason(worktreePath, branch, repo.path);
      if (offBranch) return fail(offBranch);

      // Read-only by construction: no commits, and nothing changed but the verdict.
      const headAfter = await head();
      if (headAfter !== headBefore) {
        return fail("plan critic committed to Git history; verdict rejected");
      }
      const statusAfter = await status();
      const changedBefore = new Set(changedPaths(statusBefore));
      const illegal = changedPaths(statusAfter).filter(
        (p) => !changedBefore.has(p) && p !== CRITIQUE_PATH && p !== ".ralph/",
      );
      if (illegal.length > 0) {
        return fail(`plan critic modified files other than its verdict (${illegal.join(", ")}); verdict rejected`);
      }

      const verdictMd = readFileIfExists(verdictPath);
      const critique = verdictMd ? parseEvaluation(verdictMd) : null;
      if (!critique) return fail(`plan critic wrote no usable VERDICT in ${CRITIQUE_PATH}`);

      emitEvent("critique.decided", {
        cardId,
        runId,
        payload: {
          verdict: critique.verdict,
          feedback: critique.feedback.slice(0, 500),
          findings: critique.findings,
          planVersion: plan.version,
        },
      });
      // The verdict lives on the run row and in the event; nothing is
      // committed, so the worktree is left as clean as it was found.
      removeRalphFiles(worktreePath, [CRITIQUE_FILE]);

      if (critique.verdict === "approve") {
        deps.finishRun(runId, "completed", "approve", telemetry);
        deps.moveCard(cardId, "planning", planningDestination(card), "plan critic approved");
        return;
      }

      db.update(runs).set({ feedback: critique.feedback }).where(eq(runs.id, runId)).run();
      // Counted before this run's exit reason is set, so it excludes this run.
      const prior = consecutiveCriticRevisions(cardId);
      if (prior >= MAX_CRITIC_REVISIONS) {
        deps.finishRun(runId, "completed", "revise — revision limit reached", telemetry);
        deps.moveCard(cardId, "planning", "plan_review", "plan critic revision limit — escalated to plan review");
        return;
      }
      deps.finishRun(runId, "completed", "revise", telemetry);
      // The card never left `planning`; it keeps its pipeline slot straight
      // into the re-plan.
      deps.replan(cardId);
    } catch (error) {
      if (!controller.signal.aborted) {
        const reason = `plan critic failed: ${errorMessage(error)}`;
        deps.finishRun(runId, "failed", reason.slice(0, 500), telemetry);
        if (deps.getCard(cardId)?.status === "planning") {
          deps.moveCard(cardId, "planning", "needs_attention", reason);
        }
      }
    } finally {
      deps.releaseController(runId);
      await ctx.cleanup();
      // Last, and on every exit path: the slot this run held is free.
      deps.pump();
    }
  }
}
