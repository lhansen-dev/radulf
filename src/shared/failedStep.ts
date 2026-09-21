export type PipelineStep = "plan" | "loop" | "evaluate";

export type PipelineRun = {
  kind: PipelineStep;
  status: string;
  startedAt: string;
  endedAt?: string | null;
  /** Spec 18 §3: "config" means the provider rejected the request itself, so
   * the same call fails the same way however many times it is made. */
  failureKind?: string | null;
  exitReason?: string | null;
};

/** The loop stopped on something outside its control — credentials, network,
 * a decision only the operator can make — and said so in `.ralph/BLOCKED`
 * instead of faking completion. The blocker text is the run's `feedback`. */
export const LOOP_BLOCKED_EXIT = "loop blocked";
/** Every checklist item is ticked but DONE never came: the final task's own
 * check did not pass. There is nothing left to inject, so re-running the loop
 * ends the same way in milliseconds. */
export const CHECKLIST_EXHAUSTED_EXIT = "plan checklist exhausted without a DONE signal";
/** Loop endings whose next step is the planner's, not a retry of the loop:
 * `pendingReplanFeedback` turns them into a re-plan on top of the branch. */
export const REPLAN_LOOP_EXITS: ReadonlySet<string> = new Set([LOOP_BLOCKED_EXIT, CHECKLIST_EXHAUSTED_EXIT]);

const FAILED_STATUSES = new Set(["failed", "timeout", "interrupted"]);

/** Pick the run with the latest start or completion activity. */
export function latestPipelineRun<T extends PipelineRun>(runRows: T[]): T | undefined {
  let latest: T | undefined;
  let latestActivity = "";

  for (const run of runRows) {
    const activity = run.endedAt ?? run.startedAt;
    if (
      !latest ||
      activity > latestActivity ||
      (activity === latestActivity && run.startedAt > latest.startedAt)
    ) {
      latest = run;
      latestActivity = activity;
    }
  }

  return latest;
}

/**
 * Return the failed step only when the most recently active pipeline run
 * failed *and* retrying it could plausibly do something different. Looking at
 * the latest run (instead of any historical failure) keeps successful retries
 * and later merge failures from surfacing a stale action.
 *
 * A "config" failure is excluded because it is not a bad roll of the dice: the
 * provider rejected the request. Offering a retry there produced three
 * identical one-turn, zero-token planner failures against a model the
 * installed client could not drive (spec 18 §3).
 *
 * A loop that stopped for the planner is excluded for the same reason: with
 * an exhausted checklist there is nothing to inject, so a retry fails again
 * in milliseconds, and a blocker outside the loop's control is still there.
 * On the card this came from, two such retries tripped the misconfigured-
 * stage advisory against a model that had done nothing wrong.
 */
export function retryableFailedStep(runRows: PipelineRun[]): PipelineStep | null {
  const latest = latestPipelineRun(runRows);
  if (!latest || !FAILED_STATUSES.has(latest.status)) return null;
  if (latest.failureKind === "config") return null;
  if (latest.kind === "loop" && latest.exitReason && REPLAN_LOOP_EXITS.has(latest.exitReason)) return null;
  return latest.kind;
}
