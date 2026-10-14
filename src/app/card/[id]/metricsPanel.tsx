export type Iteration = {
  id: number;
  runId: string;
  n: number;
  status: string;
  summary: string | null;
  /** The checklist task this iteration was given — see `iterationTask`.
   * Absent on rows recorded before tasks were tracked per iteration. */
  taskNumber?: number | null;
  taskCount?: number | null;
  taskText?: string | null;
  taskCompleted?: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  /** Harness-reported USD for the iteration; absent on pre-telemetry rows. */
  costUsd?: number | null;
  startedAt: string;
  endedAt: string | null;
};

/** An evaluator verdict, one per evaluate run (`reviews.run_id` is unique). */
export type Review = {
  id: string;
  runId: string;
  decision: "approved" | "rejected";
  feedback: string | null;
  mergeCommit: string | null;
  createdAt: string;
};

export type Run = {
  id: string;
  /** The plan a `plan` run wrote, when it got far enough to write one. */
  planId?: string | null;
  kind: "plan" | "loop" | "evaluate" | "critique";
  status: string;
  iterationsDone: number;
  exitReason: string | null;
  /** Spec 18 §3: what the exit reason said about the provider. "config" means
   * the request itself was rejected, so no retry can change the outcome. */
  failureKind?: string | null;
  /** An evaluate run's revise feedback, or the blocker a loop run stopped on. */
  feedback?: string | null;
  startedAt: string;
  endedAt: string | null;
  provider?: string | null;
  model?: string | null;
  /** Run-level telemetry roll-up, recorded for every kind — a plan or
   * evaluate run is its single harness invocation's numbers, a loop run is
   * the sum of its iterations. Written when the run finishes, so these are
   * null while it is still in flight (and on pre-telemetry rows). */
  promptTokens?: number | null;
  completionTokens?: number | null;
  costUsd?: number | null;
  iterations: Iteration[];
  reviews?: Review[];
};
