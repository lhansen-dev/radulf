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

export const MIN_COHORT_SIZE = 10;
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
  iterationDurationsMs: number[];
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

export type AnalyticsFilter = {
  fromMs?: number | null;   // inclusive lower bound on run.startedAt; null = no bound
  provider?: string;        // exact match on run.provider; "" / undefined = no filter
  model?: string;           // exact match on run.model; "" / undefined = no filter
};

export type AnalyticsResponse = Analytics & { providers: string[]; models: string[] };

export function filterAnalyticsInput(
  input: { cards: AnalyticsCardRow[]; runs: AnalyticsRunRow[]; iterations: AnalyticsIterationRow[] },
  filter: AnalyticsFilter,
): { cards: AnalyticsCardRow[]; runs: AnalyticsRunRow[]; iterations: AnalyticsIterationRow[] } {
  const { fromMs, provider, model } = filter;

  let filteredRuns = input.runs;
  if (fromMs != null) {
    filteredRuns = filteredRuns.filter(
      (r) => new Date(r.startedAt).getTime() >= fromMs,
    );
  }
  if (provider) {
    filteredRuns = filteredRuns.filter((r) => r.provider === provider);
  }
  if (model) {
    filteredRuns = filteredRuns.filter((r) => r.model === model);
  }

  const runIds = new Set(filteredRuns.map((r) => r.id));
  const filteredIterations = input.iterations.filter((i) => runIds.has(i.runId));

  return {
    cards: input.cards,
    runs: filteredRuns,
    iterations: filteredIterations,
  };
}

export function computeAnalytics(input: {
  cards: AnalyticsCardRow[];
  runs: AnalyticsRunRow[];
  iterations: AnalyticsIterationRow[];
}): Analytics {
  const { cards, runs, iterations } = input;

  // Totals source tokens/cost from RUNS, not iterations: a run's telemetry
  // is now populated for every kind (loop = the roll-up of its iterations;
  // plan/evaluate = their single invocation), so this is the only way plan
  // and evaluate cost shows up at all — iterations only ever existed for
  // loop.
  const promptTokens = runs.reduce((sum, r) => sum + (r.promptTokens ?? 0), 0);
  const completionTokens = runs.reduce((sum, r) => sum + (r.completionTokens ?? 0), 0);
  // Only runs that reported a cost contribute — see totals.costUsd.
  const pricedRuns = runs.filter((r) => r.costUsd != null);
  const costUsd =
    pricedRuns.length > 0
      ? pricedRuns.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)
      : null;

  // Group counts by status
  const cardStatusCounts = new Map<string, number>();
  for (const c of cards) {
    cardStatusCounts.set(c.status, (cardStatusCounts.get(c.status) ?? 0) + 1);
  }

  const runStatusCounts = new Map<string, number>();
  for (const r of runs) {
    runStatusCounts.set(r.status, (runStatusCounts.get(r.status) ?? 0) + 1);
  }

  // Tokens per run: label = card title (fallback run.id)
  const cardMap = new Map<string, string>();
  for (const c of cards) {
    cardMap.set(c.id, c.title);
  }

  const tokensPerRun: BarDatum[] = runs
    .map((r) => ({
      label: cardMap.get(r.cardId) ?? r.id,
      value: (r.promptTokens ?? 0) + (r.completionTokens ?? 0),
    }))
    .filter((d) => d.value > 0)
    .sort((a, b) => b.value - a.value);

  // Cost per run mirrors tokens per run, over priced runs only: a run with
  // nothing priced gets no bar rather than a $0 one.
  const costPerRun: BarDatum[] = pricedRuns
    .map((r) => ({
      label: cardMap.get(r.cardId) ?? r.id,
      value: r.costUsd ?? 0,
    }))
    .filter((d) => d.value > 0)
    .sort((a, b) => b.value - a.value);

  // Iteration durations: endedAt - startedAt in ms, both timestamps required, ordered by startedAt asc
  const iterationDurationsMs = iterations
    .filter((i) => i.startedAt && i.endedAt)
    .map((i) => new Date(i.endedAt!).getTime() - new Date(i.startedAt).getTime())
    .sort((a, b) => a - b);

  // Loop KPIs are iteration-granularity metrics (duration percentiles, model
  // turns, cache hit ratio) — unaffected by the runs-level telemetry above,
  // and derive from the SAME duration pipeline (iterationDurationsMs) since
  // spec 11 forbids a second duration calculation.
  const loopKpis = computeLoopKpis(iterations, iterationDurationsMs);
  const loopCohorts = computeLoopCohorts(iterations, runs);

  // Success rate: completed / (completed+failed+timeout+cancelled+interrupted)
  const terminalStatuses = ["completed", "failed", "timeout", "cancelled", "interrupted"];
  const terminal = runs.filter((r) => terminalStatuses.includes(r.status));
  const completed = terminal.filter((r) => r.status === "completed").length;
  const successRate = terminal.length === 0 ? 0 : completed / terminal.length;

  // Tokens/cost by model: grouped by the run's model
  const runModel = new Map<string, string>();
  for (const r of runs) {
    runModel.set(r.id, r.model && r.model.trim() ? r.model : "unknown");
  }

  const modelTokenMap = new Map<string, number>();
  for (const r of runs) {
    const tokens = (r.promptTokens ?? 0) + (r.completionTokens ?? 0);
    const model = runModel.get(r.id) ?? "unknown";
    modelTokenMap.set(model, (modelTokenMap.get(model) ?? 0) + tokens);
  }

  const tokensByModel: BarDatum[] = Array.from(modelTokenMap.entries())
    .filter(([, value]) => value > 0)
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);

  const modelCostMap = new Map<string, number>();
  for (const r of pricedRuns) {
    const model = runModel.get(r.id) ?? "unknown";
    modelCostMap.set(model, (modelCostMap.get(model) ?? 0) + (r.costUsd ?? 0));
  }

  const costByModel: BarDatum[] = Array.from(modelCostMap.entries())
    .filter(([, value]) => value > 0)
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);

  // Tokens/cost by role (plan/loop/evaluate) — "your planner is 70% of your
  // spend" is the real user value of measuring at run level.
  const roleTokenMap = new Map<string, number>();
  for (const r of runs) {
    const tokens = (r.promptTokens ?? 0) + (r.completionTokens ?? 0);
    roleTokenMap.set(r.kind, (roleTokenMap.get(r.kind) ?? 0) + tokens);
  }
  const tokensByRole: BarDatum[] = Array.from(roleTokenMap.entries())
    .filter(([, value]) => value > 0)
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);

  const roleCostMap = new Map<string, number>();
  for (const r of pricedRuns) {
    roleCostMap.set(r.kind, (roleCostMap.get(r.kind) ?? 0) + (r.costUsd ?? 0));
  }
  const costByRole: BarDatum[] = Array.from(roleCostMap.entries())
    .filter(([, value]) => value > 0)
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);

  // Runs by provider: count runs per provider
  const providerCounts = new Map<string, number>();
  for (const r of runs) {
    const provider = r.provider && r.provider.trim() ? r.provider : "unknown";
    providerCounts.set(provider, (providerCounts.get(provider) ?? 0) + 1);
  }

  const runsByProvider: BarDatum[] = Array.from(providerCounts.entries())
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);

  return {
    totals: {
      cards: cards.length,
      runs: runs.length,
      iterations: iterations.length,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      costUsd,
    },
    cardsByStatus: Array.from(cardStatusCounts.entries())
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value),
    runsByStatus: Array.from(runStatusCounts.entries())
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value),
    tokensPerRun,
    costPerRun,
    iterationDurationsMs,
    loopKpis,
    loopCohorts,
    successRate,
    tokensByModel,
    costByModel,
    runsByProvider,
    costByRole,
    tokensByRole,
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

function computeLoopKpis(
  iterations: AnalyticsIterationRow[],
  sortedDurationsMs: number[],
): LoopKpis {
  const sampleSize = sortedDurationsMs.length;
  const slowCount = sortedDurationsMs.filter((d) => d >= SLOW_ITERATION_MS).length;

  const turnSamples = iterations
    .map((i) => i.modelTurns)
    .filter((t): t is number => t != null);

  // Cache-hit ratio only over iterations that actually reported cache facts —
  // mixing in pre-telemetry rows would understate the ratio.
  const cacheRows = iterations.filter((i) => i.cachedInputTokens != null);
  const cachedInput = cacheRows.reduce((sum, i) => sum + (i.cachedInputTokens ?? 0), 0);
  const uncachedInput = cacheRows.reduce((sum, i) => sum + (i.promptTokens ?? 0), 0);

  const toolRows = iterations.filter((i) => i.toolDurationMs != null);
  const costRows = iterations.filter((i) => i.costUsd != null);

  return {
    sampleSize,
    durationP50Ms: percentile(sortedDurationsMs, 50),
    durationP90Ms: percentile(sortedDurationsMs, 90),
    durationP95Ms: percentile(sortedDurationsMs, 95),
    durationMaxMs: sampleSize > 0 ? sortedDurationsMs[sampleSize - 1] : null,
    slowIterationRate: sampleSize > 0 ? slowCount / sampleSize : null,
    medianModelTurns: median(turnSamples),
    modelTurnsSampleSize: turnSamples.length,
    cacheHitRatio:
      cachedInput + uncachedInput > 0 ? cachedInput / (cachedInput + uncachedInput) : null,
    cacheSampleSize: cacheRows.length,
    totalToolDurationMs:
      toolRows.length > 0 ? toolRows.reduce((sum, i) => sum + (i.toolDurationMs ?? 0), 0) : null,
    totalCostUsd:
      costRows.length > 0 ? costRows.reduce((sum, i) => sum + (i.costUsd ?? 0), 0) : null,
  };
}

/** Evaluate the spec 11 performance-policy targets over the most recent
 * ROLLOUT_SAMPLE_SIZE iterations that have a measurable duration. The
 * criteria-pass / approval-rate "no regression" condition needs a baseline
 * cohort comparison and stays a human judgment — it is not encoded here. */
export function computeRolloutAcceptance(
  iterations: AnalyticsIterationRow[],
): RolloutAcceptance {
  const measurable = iterations
    .filter((i) => i.startedAt && i.endedAt)
    .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());

  const window = measurable.slice(-ROLLOUT_SAMPLE_SIZE);
  const sufficientSample = measurable.length >= ROLLOUT_SAMPLE_SIZE;

  const durations = window
    .map((i) => new Date(i.endedAt!).getTime() - new Date(i.startedAt).getTime())
    .sort((a, b) => a - b);
  const turnSamples = window
    .map((i) => i.modelTurns)
    .filter((t): t is number => t != null);

  const medianDuration = percentile(durations, 50);
  const p90Duration = percentile(durations, 90);
  const slowRate =
    durations.length > 0
      ? durations.filter((d) => d >= SLOW_ITERATION_MS).length / durations.length
      : null;
  const medianTurns = median(turnSamples);

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
    evaluate("medianDurationMs", "Median iteration duration", medianDuration, 120_000, "atMost", "ms"),
    evaluate("p90DurationMs", "p90 iteration duration", p90Duration, 240_000, "atMost", "ms"),
    evaluate("slowIterationRate", "Iterations at least 5 minutes", slowRate, 0.05, "under", "ratio"),
    evaluate("medianModelTurns", "Median model turns", medianTurns, 14, "atMost", "count"),
  ];

  const accepted = targets.some((t) => t.pass === false)
    ? false
    : targets.every((t) => t.pass === true)
      ? true
      : null;

  return {
    windowSize: window.length,
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
  const groups = new Map<string, number[]>();
  for (const i of iterations) {
    if (!i.startedAt || !i.endedAt) continue;
    const run = runById.get(i.runId);
    const provider = i.actualProvider ?? run?.provider ?? "unknown";
    const model = i.actualModel ?? run?.model ?? "unknown";
    const harness = i.harness
      ? ` · ${i.harness}${i.harnessVersion ? ` ${i.harnessVersion}` : ""}`
      : "";
    const label = `${provider}/${model || "unknown"}${harness}`;
    const durationMs = new Date(i.endedAt).getTime() - new Date(i.startedAt).getTime();
    const group = groups.get(label);
    if (group) group.push(durationMs);
    else groups.set(label, [durationMs]);
  }

  return Array.from(groups.entries())
    .filter(([, durations]) => durations.length >= MIN_COHORT_SIZE)
    .map(([label, durations]) => {
      const sorted = durations.sort((a, b) => a - b);
      return {
        label,
        sampleSize: sorted.length,
        durationP50Ms: percentile(sorted, 50)!,
        durationP90Ms: percentile(sorted, 90)!,
      };
    })
    .sort((a, b) => b.sampleSize - a.sampleSize);
}
