import path from "node:path";
import { db, now, cards, plans, runs, repos, type CardStatus } from "@/db";
import { emitEvent } from "./events";
import type { Settings } from "./settings";
import { runHarness, type RunnerResult, type RunTelemetry } from "./harness";
import type { ProviderId } from "./providers";
import { providerBreakerStatus, recordProviderOutcome } from "./circuitBreaker";
import { recordProviderFailure } from "./providerRateLimit";
import { createWorktree, currentBranch, recordWorktree } from "./git";
import { provisionNodeModules } from "./worktreeDeps";
import { runTranscriptDir } from "./retention";
import type { RunSandboxContext } from "./sandbox/context";
import { initializeSandboxRuntimeOnce } from "./sandbox/srt";
import { checkRepoIntegrity, type RepoIntegrityBaseline } from "./integrity";

/** Shared scaffolding for the three pipeline stages (plan, loop, evaluate). */

type Card = typeof cards.$inferSelect;
type Run = typeof runs.$inferSelect;
type Repo = typeof repos.$inferSelect;
type Plan = typeof plans.$inferSelect;

/** The run statuses a stage may set. "interrupted" is the restart
 * pair: recover() writes it for a run the process died under, and a drained
 * loop writes it when it stops itself on an iteration boundary. "paused" is
 * the only one that is not an ending — the operator stopped the run and can
 * resume the card, so spec 18 §6 keeps it out of the success rate rather than
 * scoring it either way. */
export type FinishStatus =
  | "completed"
  | "failed"
  | "timeout"
  | "cancelled"
  | "interrupted"
  | "paused";

/** Reuse the card's existing worktree (retry, reject, restart) or make a fresh
 * one. `created` tells the caller to record it once its run row exists —
 * worktrees.runId is a real FK. */
export async function resolveWorktree(repo: Repo, card: Card, runId: string, prev: Run | undefined) {
  const baseBranch =
    prev?.baseBranch ?? card.baseBranch ?? (await currentBranch(repo.path, repo.defaultBranch));
  const { worktreePath, branch } =
    prev ?? (await createWorktree(repo.path, baseBranch, card.title, runId));
  if (!prev) await provisionDeps(repo.path, worktreePath, card.id);
  return { worktreePath, branch, baseBranch, created: !prev };
}

/** Best effort: a worktree without the checkout's install is what every run
 * had until now, so a provisioning failure is an event, not a failed run. No
 * runId on either event: the run row does not exist yet (events.run_id is a
 * real FK), which is also why this runs here and not in startRunRow. */
async function provisionDeps(repoPath: string, worktreePath: string, cardId: string) {
  const startedAt = Date.now();
  try {
    const mode = await provisionNodeModules(repoPath, worktreePath);
    if (mode === "skipped") return;
    emitEvent("worktree.deps_provisioned", { cardId, payload: { mode, durationMs: Date.now() - startedAt } });
  } catch (err) {
    emitEvent("worktree.deps_failed", { cardId, payload: { error: String(err).slice(0, 300) } });
  }
}

/** Insert a stage's run row, then emit the events that reference it
 * (events.run_id is a real FK, so never before the insert). */
export function startRunRow(
  values: Omit<typeof runs.$inferInsert, "startedAt" | "diskLimitMechanism" | "sandboxed"> & {
    id: string;
    cardId: string;
  },
  ctx: RunSandboxContext,
  settings: Pick<Settings, "sandboxEnabled">,
  worktreeRepoId?: string,
) {
  db.insert(runs)
    .values({
      ...values,
      startedAt: now(),
      diskLimitMechanism: ctx.diskLimitMechanism,
      sandboxed: settings.sandboxEnabled ? 1 : 0,
    })
    .run();
  const ids = { cardId: values.cardId, runId: values.id };
  if (worktreeRepoId) {
    recordWorktree(worktreeRepoId, values.id, values.worktreePath, values.branch);
  }
  if (ctx.weakerIsolationEnabled) {
    emitEvent("sandbox.weaker_isolation_enabled", {
      ...ids,
      payload: { reason: "sandboxWeakerIsolationForGoTls" },
    });
  }
  return ids;
}

/** Fail fast on a provider whose circuit breaker is open. */
export function circuitOpenReason(provider: ProviderId): string | null {
  const status = providerBreakerStatus(provider);
  if (status.state !== "open") return null;
  const until = status.openUntil ? `, retrying after ${status.openUntil}` : ", will retry after cooldown";
  return status.reason === "limit"
    ? `provider ${provider} circuit breaker open: usage limit reached${until}`
    : `provider ${provider} circuit breaker open: recent connection failures${until}`;
}

/** Spec 14 Phase 6: never fall back to an unsandboxed run silently. */
export async function sandboxUnavailableReason(settings: Pick<Settings, "sandboxEnabled">) {
  if (!settings.sandboxEnabled) return null;
  const preflight = await initializeSandboxRuntimeOnce();
  return preflight.ok ? null : `sandbox unavailable: ${preflight.errors.join("; ")}`;
}

/** Run one harness invocation writing its transcript under the run's
 * transcript directory. The stage deliberately does NOT call
 * `startTranscriptPush` itself: the web process's watcher registry
 * (`src/server/transcriptWatchers.ts`) owns exactly one `startTranscriptPush`
 * watcher per running run and pushes the transcript live over SSE, so a split
 * web/worker deployment sees it too and a single process never pushes the same
 * chunk twice (spec 25, decision 5). Single-file transcripts (plan/evaluate)
 * use iteration 0. */
export async function runWithTranscript(
  opts: Omit<Parameters<typeof runHarness>[0], "transcriptPath"> & {
    runId: string;
    file: string;
    iteration?: number;
  },
): Promise<RunnerResult> {
  // `iteration` is kept in the signature for callers; the watcher registry
  // derives it from the run row, so it is not needed here.
  const { runId, file, iteration: _iteration, ...harnessOpts } = opts;
  void _iteration;
  const transcriptPath = path.join(runTranscriptDir(runId), file);
  return await runHarness({ ...harnessOpts, transcriptPath });
}

/** Classify a single-invocation stage's harness failure (timeout, stall,
 * error) and record the provider outcome. Null means the harness succeeded. */
export function harnessFailure(
  result: RunnerResult,
  provider: ProviderId,
  label: "planner" | "evaluator" | "critic",
): { status: FinishStatus; exitReason: string; moveReason: string } | null {
  if (result.timedOut) {
    const reason =
      label === "planner" ? "planning timed out" : label === "critic" ? "plan critique timed out" : "evaluation timed out";
    return { status: "timeout", exitReason: reason, moveReason: reason };
  }
  // A dead stream, not the model's answer — worth its own reason.
  if (result.stalled) {
    return {
      status: "failed",
      exitReason: `${label} stalled: ${result.error.slice(0, 500)}`,
      moveReason: `${label} stalled`,
    };
  }
  if (result.error) {
    recordProviderFailure(provider, result.error);
    return {
      status: "failed",
      exitReason: `${label} failed: ${result.error.slice(0, 500)}`,
      moveReason: `${label} failed`,
    };
  }
  recordProviderOutcome(provider, true);
  return null;
}

/** Spec 14 run-end ordering: reap surviving processes and verify the group is
 * empty before drawing any integrity conclusion, then verify the parent repo. */
export async function integrityViolationReason(
  ctx: RunSandboxContext,
  repoPath: string,
  baseline: RepoIntegrityBaseline | null,
  runBranch: string,
): Promise<string | null> {
  const leftover = await ctx.reap();
  if (leftover.length > 0) {
    return `surviving process group(s) after reap: ${leftover.join(", ")}`;
  }
  if (!baseline) return null;
  const violations = await checkRepoIntegrity(repoPath, baseline, { runBranch, checkRefs: true });
  return violations.length > 0 ? `repo integrity violation: ${violations.join("; ")}` : null;
}


/** The orchestrator state a stage service reads and mutates, injected so each
 * service stays independently testable. */
export type StageDependencies = {
  getCard(cardId: string): Card | undefined;
  /** The owning orchestrator's `workers.id`, stamped on every run it starts. */
  workerId(): string;
  latestPlan(cardId: string): Plan | undefined;
  latestWorktreeRun(cardId: string): Run | undefined;
  moveCard(cardId: string, from: CardStatus, to: CardStatus, reason?: string): boolean;
  finishRun(runId: string, status: FinishStatus, exitReason: string, telemetry?: RunTelemetry): boolean;
  registerController(runId: string, controller: AbortController): void;
  releaseController(runId: string): void;
};
