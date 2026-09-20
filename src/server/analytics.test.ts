import { describe, it, expect } from "vitest";
import {
  computeAnalytics,
  computeRolloutAcceptance,
  filterAnalyticsInput,
  percentile,
} from "./analytics";
import type {
  AnalyticsCardRow,
  AnalyticsRunRow,
  AnalyticsIterationRow,
  AnalyticsFilter,
} from "./analytics";

const T0 = Date.parse("2026-07-01T00:00:00Z");

function run(id: string, overrides: Partial<AnalyticsRunRow> = {}): AnalyticsRunRow {
  return {
    id,
    cardId: "c1",
    kind: "loop",
    status: "completed",
    iterationsDone: 0,
    startedAt: "2026-07-01T00:00:00Z",
    endedAt: null,
    ...overrides,
  };
}

/** An iteration lasting `durationSec` (null = still running), starting `offsetSec` after T0. */
function iter(
  id: number,
  durationSec: number | null,
  overrides: Partial<AnalyticsIterationRow> = {},
  offsetSec = id * 3600,
): AnalyticsIterationRow {
  const start = T0 + offsetSec * 1000;
  return {
    id,
    runId: "r1",
    n: id,
    promptTokens: null,
    completionTokens: null,
    startedAt: new Date(start).toISOString(),
    endedAt: durationSec === null ? null : new Date(start + durationSec * 1000).toISOString(),
    ...overrides,
  };
}

const analyze = (input: {
  cards?: AnalyticsCardRow[];
  runs?: AnalyticsRunRow[];
  iterations?: AnalyticsIterationRow[];
}) => computeAnalytics({ cards: [], runs: [], iterations: [], ...input });

describe("computeAnalytics", () => {
  it("returns zeroed totals and null KPIs for empty input", () => {
    const result = analyze({});

    expect(result.totals).toEqual({
      cards: 0,
      runs: 0,
      iterations: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: null,
    });
    expect(result.cardsByStatus).toEqual([]);
    expect(result.runsByStatus).toEqual([]);
    expect(result.tokensPerRun).toEqual([]);
    expect(result.iterationDurationsMs).toEqual([]);
    expect(result.successRate).toBe(0);
    expect(result.loopKpis).toMatchObject({
      sampleSize: 0,
      durationP50Ms: null,
      durationMaxMs: null,
      slowIterationRate: null,
      medianModelTurns: null,
      cacheHitRatio: null,
      totalToolDurationMs: null,
      totalCostUsd: null,
    });
  });

  it("sums token totals across every run kind, not just loop", () => {
    // Totals come off run rows, so plan/evaluate telemetry counts too.
    const runs = [
      run("r1", { promptTokens: 300, completionTokens: 130 }),
      run("r2", { kind: "plan", promptTokens: null, completionTokens: 30 }),
    ];

    expect(analyze({ runs }).totals).toMatchObject({
      runs: 2,
      promptTokens: 300,
      completionTokens: 160,
      totalTokens: 460,
    });
  });

  it("counts cards and runs by status, sorted by count descending", () => {
    const cards: AnalyticsCardRow[] = [
      { id: "c1", title: "A", status: "running" },
      { id: "c2", title: "B", status: "completed" },
      { id: "c3", title: "C", status: "completed" },
    ];
    const runs = [run("r1", { status: "failed" }), run("r2"), run("r3")];

    const result = analyze({ cards, runs });
    expect(result.cardsByStatus).toEqual([
      { label: "completed", value: 2 },
      { label: "running", value: 1 },
    ]);
    expect(result.runsByStatus).toEqual([
      { label: "completed", value: 2 },
      { label: "failed", value: 1 },
    ]);
  });

  it("sorts iteration durations ascending and skips unmeasurable iterations", () => {
    const iterations = [
      iter(1, 5),
      iter(2, 2),
      iter(3, null),
      { ...iter(4, 10), startedAt: "" },
      iter(5, 10),
    ];
    expect(analyze({ iterations }).iterationDurationsMs).toEqual([2000, 5000, 10000]);
  });

  it("labels tokensPerRun by card title (run id for orphans), drops zero-token runs, sorts descending", () => {
    const cards: AnalyticsCardRow[] = [
      { id: "c1", title: "Feature A", status: "completed" },
      { id: "c2", title: "Feature B", status: "completed" },
    ];
    const runs = [
      run("r1", { promptTokens: 300, completionTokens: 130 }),
      run("r2", { kind: "plan", promptTokens: 10, completionTokens: 5 }),
      run("r3", { cardId: "c2", promptTokens: 300, completionTokens: 100 }),
      run("orphan", { cardId: "missing", promptTokens: 50, completionTokens: 25 }),
      run("empty"),
    ];

    expect(analyze({ cards, runs }).tokensPerRun).toEqual([
      { label: "Feature A", value: 430 },
      { label: "Feature B", value: 400 },
      { label: "orphan", value: 75 },
      { label: "Feature A", value: 15 },
    ]);
  });

  it.each([
    // completed / (completed + failed + timeout + cancelled + interrupted)
    [["completed", "completed", "failed", "timeout", "cancelled"], 0.4],
    [["completed", "running"], 1],
    [["running", "queued"], 0],
  ])("computes successRate over terminal runs: %j → %d", (statuses, expected) => {
    const runs = statuses.map((status, i) => run(`r${i}`, { status }));
    expect(analyze({ runs }).successRate).toBe(expected);
  });

  it("groups tokensByModel and runsByProvider, bucketing missing values as unknown", () => {
    const runs = [
      run("r1", { model: "opus", provider: "anthropic", promptTokens: 130, completionTokens: 60 }),
      run("r2", { model: "sonnet", provider: "openai", promptTokens: 200, completionTokens: 80 }),
      run("r3", { model: "opus", provider: "anthropic", promptTokens: 50, completionTokens: 25 }),
      run("r4", { model: "haiku", provider: "openai" }), // zero tokens → no model bucket
      run("r5", { promptTokens: 10, completionTokens: 5 }),
    ];

    const result = analyze({ runs });
    expect(result.tokensByModel).toEqual([
      { label: "sonnet", value: 280 },
      { label: "opus", value: 265 },
      { label: "unknown", value: 15 },
    ]);
    expect(result.runsByProvider).toEqual([
      { label: "anthropic", value: 2 },
      { label: "openai", value: 2 },
      { label: "unknown", value: 1 },
    ]);
  });
});

describe("filterAnalyticsInput", () => {
  const runs = [
    run("r1", { startedAt: "2025-01-01T00:00:00Z", provider: "anthropic", model: "opus" }),
    run("r2", { startedAt: "2025-01-02T00:00:00Z", provider: "openai", model: "gpt-4" }),
    run("r3", { startedAt: "2025-01-10T00:00:00Z", provider: "anthropic", model: "opus" }),
  ];
  // Every iteration's own timestamp is in range: they are kept or dropped with their run.
  const iterations = runs.map((r, i) => iter(i, null, { runId: r.id }, 40 * 86400));
  const cards: AnalyticsCardRow[] = [{ id: "c1", title: "Card A", status: "completed" }];

  it.each<[string, AnalyticsFilter, number[]]>([
    ["fromMs", { fromMs: Date.parse("2025-01-05T00:00:00Z") }, [2]],
    ["provider", { provider: "anthropic" }, [0, 2]],
    ["model", { model: "gpt-4" }, [1]],
    ["empty", {}, [0, 1, 2]],
    ["blank", { provider: "", model: "", fromMs: null }, [0, 1, 2]],
  ])("applies a %s filter to runs and their iterations, passing cards through", (_label, filter, kept) => {
    const result = filterAnalyticsInput({ cards, runs, iterations }, filter);
    expect(result.runs).toEqual(kept.map((i) => runs[i]));
    expect(result.iterations).toEqual(kept.map((i) => iterations[i]));
    expect(result.cards).toEqual(cards);
  });
});

describe("percentile", () => {
  it("uses nearest-rank on a sorted sample", () => {
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 90)).toBe(90);
    expect(percentile(sorted, 95)).toBe(100);
    expect(percentile(sorted, 100)).toBe(100);
    expect(percentile([42], 5)).toBe(42);
    expect(percentile([], 50)).toBeNull();
  });
});

describe("loopKpis", () => {
  it("derives duration percentiles and the five-minute outlier rate from iterationDurationsMs", () => {
    // 60s, 120s, 180s, 360s — one of four is ≥ 5 minutes
    const result = analyze({ iterations: [iter(1, 60), iter(2, 120), iter(3, 180), iter(4, 360)] });
    expect(result.loopKpis).toMatchObject({
      sampleSize: 4,
      durationP50Ms: 120000,
      durationMaxMs: 360000,
      slowIterationRate: 0.25,
    });
    // Same pipeline as iterationDurationsMs — no second duration calculation.
    expect(result.iterationDurationsMs).toEqual([60000, 120000, 180000, 360000]);
  });

  it("computes model-turn median, cache-hit ratio, tool time, and cost only over reporting iterations", () => {
    const iterations = [
      iter(1, 60, { promptTokens: 1000, modelTurns: 10, cachedInputTokens: 9000, toolDurationMs: 500, costUsd: 0.5 }),
      iter(2, 60, { promptTokens: 3000, modelTurns: 20, cachedInputTokens: 7000, toolDurationMs: 1500, costUsd: 0.25 }),
      // pre-telemetry row: no new facts — must not drag ratios toward zero
      iter(3, 60, { promptTokens: 99999 }),
    ];
    const { loopKpis } = analyze({ iterations });
    expect(loopKpis.medianModelTurns).toBe(10);
    expect(loopKpis.modelTurnsSampleSize).toBe(2);
    // 16000 cached / (16000 cached + 4000 uncached)
    expect(loopKpis.cacheHitRatio).toBeCloseTo(0.8);
    expect(loopKpis.cacheSampleSize).toBe(2);
    expect(loopKpis.totalToolDurationMs).toBe(2000);
    expect(loopKpis.totalCostUsd).toBeCloseTo(0.75);
  });
});

describe("cost aggregates", () => {
  // Cost lives on the run row (a plan/evaluate invocation's own number, or a
  // loop run's roll-up of its iterations) — not summed from iterations.
  it.each<[string, (number | undefined)[], number | null]>([
    ["sums reported costs, skipping pre-telemetry runs", [0.0123, 0.0004, undefined], 0.0127],
    // An unpriced sample must never read as free...
    ["stays null when nothing was priced", [undefined, undefined], null],
    // ...but local models have zero rates: that is a real $0.
    ["keeps a reported zero as zero", [0], 0],
  ])("totals.costUsd %s", (_label, costs, expected) => {
    const { totals } = analyze({ runs: costs.map((costUsd, i) => run(`r${i}`, { costUsd })) });
    if (expected === null) expect(totals.costUsd).toBeNull();
    else expect(totals.costUsd).toBeCloseTo(expected);
  });

  it("labels costPerRun by card title, sorts descending, and omits unpriced runs", () => {
    const cards = [
      { id: "c1", title: "Cheap task", status: "completed" },
      { id: "c2", title: "Costly task", status: "completed" },
    ];
    const runs = [
      run("r1", { costUsd: 0.01 }),
      run("r2", { cardId: "c2", costUsd: 0.25 }),
      run("r3"),
    ];
    expect(analyze({ cards, runs }).costPerRun).toEqual([
      { label: "Costly task", value: 0.25 },
      { label: "Cheap task", value: 0.01 },
    ]);
  });

  it("groups costByModel by the run's model, bucketing a blank model as unknown", () => {
    const runs = [
      run("r1", { model: "opus", costUsd: 0.3 }),
      run("r2", { model: "haiku", costUsd: 0.1 }),
      run("r3", { model: null, costUsd: 0.2 }),
    ];
    expect(analyze({ runs }).costByModel).toEqual([
      { label: "opus", value: 0.3 },
      { label: "unknown", value: 0.2 },
      { label: "haiku", value: 0.1 },
    ]);
  });

  it("groups costByRole and tokensByRole by run kind — the planner-vs-loop-vs-evaluator split", () => {
    const runs = [
      run("p1", { kind: "plan", promptTokens: 500, completionTokens: 100, costUsd: 0.7 }),
      run("l1", { kind: "loop", promptTokens: 200, completionTokens: 50, costUsd: 0.2 }),
      run("e1", { kind: "evaluate", promptTokens: 100, completionTokens: 20, costUsd: 0.1 }),
    ];
    const { costByRole, tokensByRole } = analyze({ runs });
    expect(costByRole).toEqual([
      { label: "plan", value: 0.7 },
      { label: "loop", value: 0.2 },
      { label: "evaluate", value: 0.1 },
    ]);
    expect(tokensByRole).toEqual([
      { label: "plan", value: 600 },
      { label: "loop", value: 250 },
      { label: "evaluate", value: 120 },
    ]);
  });
});

describe("loopCohorts", () => {
  const iters = (
    runId: string,
    count: number,
    durationSec: number,
    extra: Partial<AnalyticsIterationRow> = {},
  ) => Array.from({ length: count }, (_, i) => iter(i, durationSec, { runId, ...extra }, 0));

  it("groups by actual provider/model/harness/version and hides cohorts under 10 iterations", () => {
    const runs = [
      run("r1", { provider: "openrouter", model: "requested-model" }),
      run("r2", { provider: "omlx", model: "m2" }),
    ];
    const iterations = [
      ...iters("r1", 10, 60, {
        actualProvider: "openrouter",
        actualModel: "actual-model",
        harness: "opencode",
        harnessVersion: "1.17.18",
      }),
      ...iters("r2", 9, 30), // under the minimum — never reported
    ];
    expect(analyze({ runs, iterations }).loopCohorts).toEqual([
      {
        label: "openrouter/actual-model · opencode 1.17.18",
        sampleSize: 10,
        durationP50Ms: 60000,
        durationP90Ms: 60000,
      },
    ]);
  });

  it("falls back to the run's requested provider/model and merges runs that match", () => {
    // Neither run reaches the 10-iteration minimum alone.
    const runs = [
      run("r1", { provider: "anthropic", model: "sonnet" }),
      run("r2", { provider: "anthropic", model: "sonnet" }),
    ];
    const iterations = [...iters("r1", 6, 90), ...iters("r2", 6, 90)];
    expect(analyze({ runs, iterations }).loopCohorts).toEqual([
      { label: "anthropic/sonnet", sampleSize: 12, durationP50Ms: 90000, durationP90Ms: 90000 },
    ]);
  });
});

describe("computeRolloutAcceptance", () => {
  /** `count` consecutive iterations of `durationSec` with `modelTurns`, ids from `from`. */
  const batch = (count: number, durationSec: number, modelTurns: number | null, from = 1) =>
    Array.from({ length: count }, (_, i) => iter(from + i, durationSec, { modelTurns }));
  const target = (result: ReturnType<typeof computeRolloutAcceptance>, key: string) =>
    result.targets.find((t) => t.key === key)!;

  it("reports an insufficient sample with null passes below 30 iterations", () => {
    const result = computeRolloutAcceptance([...batch(1, 60, 5), ...batch(1, 90, 6, 2)]);

    expect(result).toMatchObject({ sufficientSample: false, windowSize: 2, requiredSampleSize: 30, accepted: null });
    for (const t of result.targets) expect(t.pass).toBeNull();
    // Actuals are still measured so the UI can show progress
    expect(target(result, "medianDurationMs").actual).not.toBeNull();
  });

  it("accepts the most recent 30 measurable iterations when all four targets are met", () => {
    // 30 old slow iterations and an unmeasurable one fall outside the window.
    const result = computeRolloutAcceptance([
      ...batch(30, 400, 20),
      iter(31, null),
      ...batch(30, 90, 9, 32),
    ]);

    expect(result.sufficientSample).toBe(true);
    expect(result.windowSize).toBe(30);
    expect(result.accepted).toBe(true);
    expect(result.targets.map((t) => t.pass)).toEqual([true, true, true, true]);
  });

  it("fails on a slow tail: p90 above 240s and too many slow iterations", () => {
    // 5 of 30 at 300s → p90 lands in the slow tail, slow rate 16.7%.
    const result = computeRolloutAcceptance([...batch(25, 60, 8), ...batch(5, 300, 8, 26)]);

    expect(result.accepted).toBe(false);
    expect(target(result, "p90DurationMs").pass).toBe(false);
    expect(target(result, "slowIterationRate").pass).toBe(false);
    expect(target(result, "medianDurationMs").pass).toBe(true);

    // A single slow iteration (3.3%) is within the slow-rate target.
    const oneSlow = computeRolloutAcceptance([...batch(29, 60, 8), ...batch(1, 300, 8, 30)]);
    expect(target(oneSlow, "slowIterationRate").pass).toBe(true);
  });

  it("leaves acceptance null when model turns are unreported", () => {
    const result = computeRolloutAcceptance(batch(30, 100, null));

    expect(target(result, "medianModelTurns").pass).toBeNull();
    expect(target(result, "medianDurationMs").pass).toBe(true);
    expect(result.accepted).toBeNull();
  });
});
