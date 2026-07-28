export type PipelineStep = "plan" | "loop" | "evaluate";

export type PipelineRun = {
  kind: PipelineStep;
  status: string;
  startedAt: string;
  endedAt?: string | null;
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
 * failed. Looking at the latest run (instead of any historical failure) keeps
 * successful retries and later merge failures from surfacing a stale action.
 */
export function retryableFailedStep(runRows: PipelineRun[]): PipelineStep | null {
  const latest = latestPipelineRun(runRows);
  return latest && FAILED_STATUSES.has(latest.status) ? latest.kind : null;
}
