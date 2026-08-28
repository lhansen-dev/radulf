import { index, sqliteTable, text, integer, real, uniqueIndex } from "drizzle-orm/sqlite-core";

export const repos = sqliteTable("repos", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  path: text("path").notNull().unique(),
  defaultBranch: text("default_branch").notNull().default("main"),
  // Spec 14 install-script gate: JSON array of { name, version, scriptHash }
  // entries a human approved for this repo. A version bump or edited script
  // body changes the key and re-fires the gate. The read-modify-write race
  // across concurrent approvals is benign — a lost write just re-fires.
  approvedInstallScripts: text("approved_install_scripts").notNull().default("[]"),
  createdAt: text("created_at").notNull(),
});

/** One human-approved package lifecycle script (spec 14 install-script gate). */
export type ApprovedInstallScript = {
  name: string;
  version: string;
  scriptHash: string;
};

/** The real disk bound in force for a run (spec 14). */
export const DISK_LIMIT_MECHANISMS = [
  "watchdog",
  "apfs-quota",
  "sparse-image",
  "cgroup",
] as const;
export type DiskLimitMechanism = (typeof DISK_LIMIT_MECHANISMS)[number];

// Board mapping: backlog → Backlog; todo → Todo; planning/ready/looping/
// evaluating → In Progress; review → In Review; reviewing is a short-lived
// atomic decision claim; needs_attention → Needs Attention; done → Done.
// (spec 14: the summarizer role is gone — the evaluator writes the summary,
// so there is no `summarizing` status.)
export const CARD_STATUSES = [
  "backlog",
  "todo",
  "planning",
  "plan_review",
  "ready",
  "looping",
  "evaluating",
  "paused",
  "review",
  "reviewing",
  "needs_attention",
  "done",
  "abandoned",
] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

export const cards = sqliteTable(
  "cards",
  {
    id: text("id").primaryKey(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").$type<CardStatus>().notNull().default("backlog"),
    position: real("position").notNull().default(0),
    baseBranch: text("base_branch"),
    source: text("source").$type<"user" | "agent">().notNull().default("user"),
    maxIterations: integer("max_iterations"),
    reviewPlanBeforeImplementation: integer("review_plan_before_implementation")
      .notNull()
      .default(0),
    // When set, an evaluator `approve` verdict skips the human In Review gate
    // and merges straight through the same load-bearing review path. Trusts the
    // evaluator; seeded per card from the `defaultAutoApprove` global setting.
    autoApprove: integer("auto_approve").notNull().default(0),
    timeoutMinutes: integer("timeout_minutes"),
    plannerModel: text("planner_model"),
    loopModel: text("loop_model"),
    evaluatorModel: text("evaluator_model"),
    summary: text("summary"),
    startedAt: text("started_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("cards_status_position_idx").on(table.status, table.position),
    index("cards_repo_status_position_idx").on(table.repoId, table.status, table.position),
  ],
);

export const plans = sqliteTable("plans", {
  id: text("id").primaryKey(),
  cardId: text("card_id")
    .notNull()
    .references(() => cards.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  planMd: text("plan_md").notNull(),
  promptMd: text("prompt_md").notNull(),
  acceptanceCriteria: text("acceptance_criteria").notNull(),
  feedback: text("feedback"),
  createdAt: text("created_at").notNull(),
}, (table) => [index("plans_card_version_idx").on(table.cardId, table.version)]);

export type RunStatus =
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "cancelled"
  | "interrupted"
  | "paused";

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  cardId: text("card_id")
    .notNull()
    .references(() => cards.id, { onDelete: "cascade" }),
  planId: text("plan_id").references(() => plans.id),
  // Historical rows may carry the retired "summarize" kind (spec 14 dropped
  // the role); new rows are only ever plan/loop/evaluate.
  kind: text("kind").$type<"plan" | "loop" | "evaluate">().notNull(),
  status: text("status").$type<RunStatus>().notNull().default("running"),
  worktreePath: text("worktree_path").notNull(),
  branch: text("branch").notNull(),
  baseBranch: text("base_branch"),
  iterationsDone: integer("iterations_done").notNull().default(0),
  exitReason: text("exit_reason"),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
  provider: text("provider"),
  model: text("model"),
  // Spec 14: stamped per run. 1 = the run's agent bash was sandbox-wrapped;
  // 0 = sandboxEnabled was off; null = pre-sandbox run (unknown).
  sandboxed: integer("sandboxed"),
  // Spec 14: which disk bound was actually in force for the run.
  diskLimitMechanism: text("disk_limit_mechanism").$type<DiskLimitMechanism>(),
  // Run-level telemetry roll-up, mirroring the iterations column set: a plan
  // or evaluate run is the single runHarness invocation's numbers directly;
  // a loop run is the sum of its iterations, written when the run finishes.
  // All nullable — null means unreported, never coerced to zero, same
  // convention as iterations.
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  cachedInputTokens: integer("cached_input_tokens"),
  cacheWriteTokens: integer("cache_write_tokens"),
  reasoningTokens: integer("reasoning_tokens"),
  modelTurns: integer("model_turns"),
  toolCalls: integer("tool_calls"),
  toolDurationMs: integer("tool_duration_ms"),
  firstTokenMs: integer("first_token_ms"),
  costUsd: real("cost_usd"),
  harness: text("harness"),
  harnessVersion: text("harness_version"),
}, (table) => [index("runs_card_started_idx").on(table.cardId, table.startedAt)]);

export const iterations = sqliteTable("iterations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  n: integer("n").notNull(),
  status: text("status")
    .$type<"running" | "completed" | "failed">()
    .notNull()
    .default("running"),
  transcriptPath: text("transcript_path").notNull(),
  summary: text("summary"),
  // UNCACHED cumulative input across every model turn of the iteration —
  // historical name kept for migration compatibility. Not a context size;
  // cache reads live in cachedInputTokens.
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  // Spec 11 Phase 0 telemetry — all nullable; null means the harness did not
  // report the fact (never coerced to zero).
  cachedInputTokens: integer("cached_input_tokens"),
  cacheWriteTokens: integer("cache_write_tokens"),
  reasoningTokens: integer("reasoning_tokens"),
  modelTurns: integer("model_turns"),
  toolCalls: integer("tool_calls"),
  toolDurationMs: integer("tool_duration_ms"),
  firstTokenMs: integer("first_token_ms"),
  costUsd: real("cost_usd"),
  // What actually served the iteration — the run row keeps the requested
  // provider/model pair, but a blank model resolves to the provider's default,
  // so the concrete id that ran is recorded here.
  actualProvider: text("actual_provider"),
  actualModel: text("actual_model"),
  harness: text("harness"),
  harnessVersion: text("harness_version"),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
}, (table) => [index("iterations_run_n_idx").on(table.runId, table.n)]);

export const reviews = sqliteTable(
  "reviews",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    decision: text("decision").$type<"approved" | "rejected">().notNull(),
    feedback: text("feedback"),
    mergeCommit: text("merge_commit"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("reviews_run_id_unique").on(table.runId)],
);

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Nullable + set-null on delete: an event may be card-scoped, run-scoped,
  // both, or neither (see emitEvent call sites), and events is the audit
  // trail — a deleted card/run should clear the reference, not take its
  // history with it.
  cardId: text("card_id").references(() => cards.id, { onDelete: "set null" }),
  runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
  type: text("type").notNull(),
  payload: text("payload").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
}, (table) => [index("events_card_id_idx").on(table.cardId, table.id)]);

// running → looping between task cards; completed → deadline reached (or
// proposer ran dry) with no unresolved failure; stopped → user-requested
// stop honored between tasks; failed → 3 consecutive task failures.
export const IMPROVEMENT_RUN_STATUSES = [
  "running",
  "completed",
  "stopped",
  "failed",
] as const;
export type ImprovementRunStatus = (typeof IMPROVEMENT_RUN_STATUSES)[number];

export const improvementRuns = sqliteTable(
  "improvement_runs",
  {
    id: text("id").primaryKey(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    status: text("status").$type<ImprovementRunStatus>().notNull().default("running"),
    // Cut off `baseBranch` once at run creation (`ralph/improve-<ts>`); every
    // spawned card uses it as its own `baseBranch`, so approve-merges fold
    // back into it with no new merge code.
    featureBranch: text("feature_branch").notNull(),
    baseBranch: text("base_branch").notNull(),
    focusPrompt: text("focus_prompt"),
    plannerModel: text("planner_model"),
    loopModel: text("loop_model"),
    evaluatorModel: text("evaluator_model"),
    plannerReasoning: text("planner_reasoning"),
    loopReasoning: text("loop_reasoning"),
    evaluatorReasoning: text("evaluator_reasoning"),
    maxIterations: integer("max_iterations"),
    timeoutMinutes: integer("timeout_minutes"),
    // Run-level budget end (ISO). Checked only between tasks — a soft gate,
    // never used to kill a task mid-flight.
    deadlineAt: text("deadline_at").notNull(),
    // In-flight card, persisted so a server restart can re-attach (N2/N3).
    currentCardId: text("current_card_id"),
    tasksCreated: integer("tasks_created").notNull().default(0),
    tasksSucceeded: integer("tasks_succeeded").notNull().default(0),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    endedAt: text("ended_at"),
  },
  (table) => [index("improvement_runs_repo_status_idx").on(table.repoId, table.status)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// One row per physical worktree directory (not per run — a card's plan/loop/
// evaluate runs share one worktree across a cycle, see createWorktree's one
// call site). runId is nullable + set-null on delete so pruneRuntimeHistory
// deleting the owning run row never orphans the record the GC sweep depends
// on. removedAt null = still on disk as far as we know; set = cleaned up.
export const worktrees = sqliteTable(
  "worktrees",
  {
    id: text("id").primaryKey(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    path: text("path").notNull().unique(),
    branch: text("branch").notNull(),
    createdAt: text("created_at").notNull(),
    removedAt: text("removed_at"),
  },
  (table) => [index("worktrees_removed_at_idx").on(table.removedAt)],
);
