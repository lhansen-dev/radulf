import { groupBy } from "./queryGrouping";

export type BarDatum = { label: string; value: number };

export type AnalyticsCardRow = {
  id: string;
  title: string;
  status: string;
};

export type AnalyticsRunRow = {
  id: string;
  cardId: string;
  kind: string;
  status: string;
  iterationsDone: number;
  startedAt: string;
  endedAt: string | null;
  provider?: string | null;
  model?: string | null;
  /** Run-level telemetry roll-up (spec: cost visibility for the planner and
   * evaluator) — populated for every kind, not just loop. A loop run's
   * value is the sum of its iterations; plan/evaluate write their single
   * invocation's numbers directly. Absent/null on runs that predate these
   * columns, same "never coerced to zero" convention as iterations. */
  promptTokens?: number | null;
  completionTokens?: number | null;
  costUsd?: number | null;
};

export type AnalyticsIterationRow = {
  id: number;
  runId: string;
  n: number;
  /** Uncached cumulative input across the iteration's model turns — NOT a
   * context size and NOT total input (cache reads are separate). */
  promptTokens: number | null;
  completionTokens: number | null;
  cachedInputTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
  modelTurns?: number | null;
  toolCalls?: number | null;
  toolDurationMs?: number | null;
  costUsd?: number | null;
  actualProvider?: string | null;
  actualModel?: string | null;
  harness?: string | null;
  harnessVersion?: string | null;
  startedAt: string;
  endedAt: string | null;
};

/** Iteration-level loop KPIs (spec 11 Phase 0). Every metric carries its own
 * sample size because older iterations predate the telemetry columns. A null
 * metric means no iteration in the sample reported the underlying fact. */
export type LoopKpis = {
  /** Iterations with a measurable duration — the sample behind the percentiles. */
  sampleSize: number;
  durationP50Ms: number | null;
  durationP90Ms: number | null;
  durationP95Ms: number | null;
  durationMaxMs: number | null;
  /** Share of iterations taking at least five minutes. */
  slowIterationRate: number | null;
  medianModelTurns: number | null;
  modelTurnsSampleSize: number;
  /** cached input / (cached + uncached input), over iterations reporting cache facts. */
  cacheHitRatio: number | null;
  cacheSampleSize: number;
  totalToolDurationMs: number | null;
  totalCostUsd: number | null;
};

/** One actual provider/model/harness/version cohort — only cohorts with at
 * least MIN_COHORT_SIZE iterations are reported, so small samples never get
 * compared. */
export type LoopCohort = {
  label: string;
  sampleSize: number;
  durationP50Ms: number;
  durationP90Ms: number;
};

const MIN_COHORT_SIZE = 10;
/** The flat "this is taking a while" mark. Still the comparison point for the
 * cross-run KPIs below, which have no single run's budget to scale to, and
 * since spec 18 §10 also the floor under the orchestrator's per-iteration
 * slow signal rather than the whole of it. */
export const SLOW_ITERATION_MS = 5 * 60 * 1000;

/** Spec 11 rollout acceptance: the performance-policy targets, evaluated
 * over the most recent ROLLOUT_SAMPLE_SIZE measurable iterations. */
export const ROLLOUT_SAMPLE_SIZE = 30;

export type RolloutTarget = {
  key: "medianDurationMs" | "p90DurationMs" | "slowIterationRate" | "medianModelTurns";
  label: string;
  /** Measured value over the window; null when no iteration reported the fact. */
  actual: number | null;
  /** Threshold the actual must satisfy. */
  target: number;
  /** "atMost" — actual ≤ target; "under" — actual < target. */
  comparison: "atMost" | "under";
  unit: "ms" | "ratio" | "count";
  /** null when the sample is insufficient or the fact is unreported. */
  pass: boolean | null;
};

export type RolloutAcceptance = {
  /** Iterations actually evaluated (the most recent measurable ones). */
  windowSize: number;
  requiredSampleSize: number;
  sufficientSample: boolean;
  targets: RolloutTarget[];
  /** true — all targets met; false — at least one missed; null — a target is
   * not yet measurable (insufficient sample or unreported model turns). */
  accepted: boolean | null;
};

export type Analytics = {
  totals: {
    cards: number;
    runs: number;
    iterations: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    /** Summed harness-reported USD; null when no iteration reported a cost, so
     * an unpriced sample is never presented as free. */
    costUsd: number | null;
  };
  cardsByStatus: BarDatum[];
  runsByStatus: BarDatum[];
  tokensPerRun: BarDatum[];
  costPerRun: BarDatum[];
  loopKpis: LoopKpis;
  loopCohorts: LoopCohort[];
  successRate: number;
  tokensByModel: BarDatum[];
  costByModel: BarDatum[];
  runsByProvider: BarDatum[];
  /** Cost/tokens grouped by run kind (plan/loop/evaluate) — "your planner is
   * 70% of your spend" is the whole point of measuring per-role. */
  costByRole: BarDatum[];
  tokensByRole: BarDatum[];
};

export type AnalyticsResponse = Analytics & { providers: string[]; models: string[] };

/** Sum `value` per `label`, drop empty groups, largest first. */
function groupBars<T>(rows: T[], label: (row: T) => string, value: (row: T) => number): BarDatum[] {
  const groups = new Map<string, number>();
  for (const row of rows) groups.set(label(row), (groups.get(label(row)) ?? 0) + value(row));
  return byValueDesc([...groups].map(([l, v]) => ({ label: l, value: v })));
}

function byValueDesc(bars: BarDatum[]): BarDatum[] {
  return bars.filter((d) => d.value > 0).sort((a, b) => b.value - a.value);
}

/** Sum of the reported values, or null when none reported — an unreported
 * fact is never presented as zero. */
function sumReported(values: (number | null | undefined)[]): number | null {
  const present = values.filter((v): v is number => v != null);
  return present.length > 0 ? present.reduce((sum, v) => sum + v, 0) : null;
}

const durationMs = (i: AnalyticsIterationRow) =>
  new Date(i.endedAt!).getTime() - new Date(i.startedAt).getTime();

export function computeAnalytics(input: {
  cards: AnalyticsCardRow[];
  runs: AnalyticsRunRow[];
  iterations: AnalyticsIterationRow[];
}): Analytics {
  const { cards, runs, iterations } = input;

  // Totals source tokens/cost from RUNS, not iterations: a run's telemetry is
  // populated for every kind (loop = the roll-up of its iterations;
  // plan/evaluate = their single invocation), so this is the only way plan and
  // evaluate cost shows up at all.
  const tokens = (r: AnalyticsRunRow) => (r.promptTokens ?? 0) + (r.completionTokens ?? 0);
  const cost = (r: AnalyticsRunRow) => r.costUsd ?? 0;
  const promptTokens = runs.reduce((sum, r) => sum + (r.promptTokens ?? 0), 0);
  const completionTokens = runs.reduce((sum, r) => sum + (r.completionTokens ?? 0), 0);
  // Only runs that reported a cost contribute — a run with nothing priced
  // gets no bar rather than a $0 one.
  const pricedRuns = runs.filter((r) => r.costUsd != null);

  const cardTitle = new Map(cards.map((c) => [c.id, c.title]));
  const runLabel = (r: AnalyticsRunRow) => cardTitle.get(r.cardId) ?? r.id;
  const model = (r: AnalyticsRunRow) => (r.model?.trim() ? r.model : "unknown");
  const count = () => 1;

  // "paused" is deliberately absent (spec 18 §6): the operator stopped that
  // run, so it is neither a success nor a failure and belongs on neither side
  // of the rate.
  const terminalStatuses = ["completed", "failed", "timeout", "cancelled", "interrupted"];
  const terminal = runs.filter((r) => terminalStatuses.includes(r.status));
  const completed = terminal.filter((r) => r.status === "completed").length;

  return {
    totals: {
      cards: cards.length,
      runs: runs.length,
      iterations: iterations.length,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      costUsd: sumReported(runs.map((r) => r.costUsd)),
    },
    cardsByStatus: groupBars(cards, (c) => c.status, count),
    runsByStatus: groupBars(runs, (r) => r.status, count),
    tokensPerRun: byValueDesc(runs.map((r) => ({ label: runLabel(r), value: tokens(r) }))),
    costPerRun: byValueDesc(pricedRuns.map((r) => ({ label: runLabel(r), value: cost(r) }))),
    loopKpis: computeLoopKpis(iterations),
    loopCohorts: computeLoopCohorts(iterations, runs),
    successRate: terminal.length === 0 ? 0 : completed / terminal.length,
    tokensByModel: groupBars(runs, model, tokens),
    costByModel: groupBars(pricedRuns, model, cost),
    runsByProvider: groupBars(runs, (r) => (r.provider?.trim() ? r.provider : "unknown"), count),
    // "Your planner is 70% of your spend" is the point of measuring per role.
    costByRole: groupBars(pricedRuns, (r) => r.kind, cost),
    tokensByRole: groupBars(runs, (r) => r.kind, tokens),
  };
}

/** Nearest-rank percentile over an ascending-sorted array. */
export function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length, Math.max(1, rank)) - 1];
}

function median(values: number[]): number | null {
  return percentile([...values].sort((a, b) => a - b), 50);
}

/** The duration and model-turn facts both the loop KPIs and the rollout
 * acceptance read off a set of iterations: the measurable durations ranked
 * ascending (spec 11 forbids a second duration calculation, so this is the
 * one place it happens), their p50 and p90, the share at or over
 * SLOW_ITERATION_MS, and the median of the reported model turns. */
function loopWindowStats(iterations: AnalyticsIterationRow[]) {
  const sortedDurationsMs = iterations
    .filter((i) => i.startedAt && i.endedAt)
    .map(durationMs)
    .sort((a, b) => a - b);
  const slowCount = sortedDurationsMs.filter((d) => d >= SLOW_ITERATION_MS).length;
  const turnSamples = iterations
    .map((i) => i.modelTurns)
    .filter((t): t is number => t != null);
  return {
    sortedDurationsMs,
    durationP50Ms: percentile(sortedDurationsMs, 50),
    durationP90Ms: percentile(sortedDurationsMs, 90),
    slowIterationRate: sortedDurationsMs.length > 0 ? slowCount / sortedDurationsMs.length : null,
    medianModelTurns: median(turnSamples),
    modelTurnsSampleSize: turnSamples.length,
  };
}

function computeLoopKpis(iterations: AnalyticsIterationRow[]): LoopKpis {
  const stats = loopWindowStats(iterations);
  const { sortedDurationsMs } = stats;
  const sampleSize = sortedDurationsMs.length;

  // Cache-hit ratio only over iterations that actually reported cache facts —
  // mixing in pre-telemetry rows would understate the ratio.
  const cacheRows = iterations.filter((i) => i.cachedInputTokens != null);
  const cachedInput = cacheRows.reduce((sum, i) => sum + (i.cachedInputTokens ?? 0), 0);
  const uncachedInput = cacheRows.reduce((sum, i) => sum + (i.promptTokens ?? 0), 0);

  return {
    sampleSize,
    durationP50Ms: stats.durationP50Ms,
    durationP90Ms: stats.durationP90Ms,
    durationP95Ms: percentile(sortedDurationsMs, 95),
    durationMaxMs: sampleSize > 0 ? sortedDurationsMs[sampleSize - 1] : null,
    slowIterationRate: stats.slowIterationRate,
    medianModelTurns: stats.medianModelTurns,
    modelTurnsSampleSize: stats.modelTurnsSampleSize,
    cacheHitRatio:
      cachedInput + uncachedInput > 0 ? cachedInput / (cachedInput + uncachedInput) : null,
    cacheSampleSize: cacheRows.length,
    totalToolDurationMs: sumReported(iterations.map((i) => i.toolDurationMs)),
    totalCostUsd: sumReported(iterations.map((i) => i.costUsd)),
  };
}

/** Evaluate the spec 11 performance-policy targets over `iterations`: the
 * rollout window, i.e. the most recent ROLLOUT_SAMPLE_SIZE iterations with a
 * measurable duration, which the caller's query selects. The criteria-pass /
 * approval-rate "no regression" condition needs a baseline cohort comparison
 * and stays a human judgment — it is not encoded here. */
export function computeRolloutAcceptance(
  iterations: AnalyticsIterationRow[],
): RolloutAcceptance {
  const stats = loopWindowStats(iterations);
  const windowSize = stats.sortedDurationsMs.length;
  const sufficientSample = windowSize >= ROLLOUT_SAMPLE_SIZE;

  function evaluate(
    key: RolloutTarget["key"],
    label: string,
    actual: number | null,
    target: number,
    comparison: RolloutTarget["comparison"],
    unit: RolloutTarget["unit"],
  ): RolloutTarget {
    const pass =
      !sufficientSample || actual == null
        ? null
        : comparison === "atMost"
          ? actual <= target
          : actual < target;
    return { key, label, actual, target, comparison, unit, pass };
  }

  const targets = [
    evaluate("medianDurationMs", "Median iteration duration", stats.durationP50Ms, 120_000, "atMost", "ms"),
    evaluate("p90DurationMs", "p90 iteration duration", stats.durationP90Ms, 240_000, "atMost", "ms"),
    evaluate("slowIterationRate", "Iterations at least 5 minutes", stats.slowIterationRate, 0.05, "under", "ratio"),
    evaluate("medianModelTurns", "Median model turns", stats.medianModelTurns, 14, "atMost", "count"),
  ];

  const accepted = targets.some((t) => t.pass === false)
    ? false
    : targets.every((t) => t.pass === true)
      ? true
      : null;

  return {
    windowSize,
    requiredSampleSize: ROLLOUT_SAMPLE_SIZE,
    sufficientSample,
    targets,
    accepted,
  };
}

function computeLoopCohorts(
  iterations: AnalyticsIterationRow[],
  runs: AnalyticsRunRow[],
): LoopCohort[] {
  // Breakdowns use ACTUAL provider/model/harness/version. Pre-telemetry rows
  // fall back to the run's requested pair, which was accurate absent fallback.
  const runById = new Map(runs.map((r) => [r.id, r]));
  const cohortLabel = (i: AnalyticsIterationRow) => {
    const run = runById.get(i.runId);
    const provider = i.actualProvider ?? run?.provider ?? "unknown";
    const model = i.actualModel ?? run?.model ?? "unknown";
    const harness = i.harness
      ? ` · ${i.harness}${i.harnessVersion ? ` ${i.harnessVersion}` : ""}`
      : "";
    return `${provider}/${model || "unknown"}${harness}`;
  };
  const groups = groupBy(iterations.filter((i) => i.startedAt && i.endedAt), cohortLabel);

  return Array.from(groups.entries())
    .filter(([, cohort]) => cohort.length >= MIN_COHORT_SIZE)
    .map(([label, cohort]) => {
      const sorted = cohort.map(durationMs).sort((a, b) => a - b);
      return {
        label,
        sampleSize: sorted.length,
        durationP50Ms: percentile(sorted, 50)!,
        durationP90Ms: percentile(sorted, 90)!,
      };
    })
    .sort((a, b) => b.sampleSize - a.sampleSize);
}
