export type PipelineStep = "plan" | "loop" | "evaluate";

export type PipelineRun = {
  kind: PipelineStep;
  status: string;
  startedAt: string;
  endedAt?: string | null;
  /** Spec 18 §3: "config" means the provider rejected the request itself, so
   * the same call fails the same way however many times it is made. */
  failureKind?: string | null;
};

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
 */
export function retryableFailedStep(runRows: PipelineRun[]): PipelineStep | null {
  const latest = latestPipelineRun(runRows);
  if (!latest || !FAILED_STATUSES.has(latest.status)) return null;
  return latest.failureKind === "config" ? null : latest.kind;
}
