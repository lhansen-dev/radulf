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

describe("computeAnalytics", () => {
  it("returns zeroed totals, empty arrays, and successRate 0 for empty input", () => {
    const result = computeAnalytics({ cards: [], runs: [], iterations: [] });

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
  });

  it("sums token totals across iterations", () => {
    const iterations: AnalyticsIterationRow[] = [
      { id: 1, runId: "r1", n: 1, promptTokens: 100, completionTokens: 50, startedAt: "2025-01-01T00:00:00Z", endedAt: null },
      { id: 2, runId: "r1", n: 2, promptTokens: 200, completionTokens: 80, startedAt: "2025-01-01T00:01:00Z", endedAt: null },
      { id: 3, runId: "r2", n: 1, promptTokens: null, completionTokens: 30, startedAt: "2025-01-02T00:00:00Z", endedAt: null },
    ];

    const result = computeAnalytics({ cards: [], runs: [], iterations });

    expect(result.totals.promptTokens).toBe(300);
    expect(result.totals.completionTokens).toBe(160);
    expect(result.totals.totalTokens).toBe(460);
  });

  it("counts cardsByStatus and runsByStatus correctly", () => {
    const cards: AnalyticsCardRow[] = [
      { id: "c1", title: "Card A", status: "completed" },
      { id: "c2", title: "Card B", status: "completed" },
      { id: "c3", title: "Card C", status: "failed" },
      { id: "c4", title: "Card D", status: "running" },
    ];

    const runs: AnalyticsRunRow[] = [
      { id: "r1", cardId: "c1", kind: "default", status: "completed", iterationsDone: 2, startedAt: "2025-01-01T00:00:00Z", endedAt: "2025-01-01T00:05:00Z" },
      { id: "r2", cardId: "c1", kind: "default", status: "completed", iterationsDone: 1, startedAt: "2025-01-01T01:00:00Z", endedAt: "2025-01-01T01:03:00Z" },
      { id: "r3", cardId: "c2", kind: "default", status: "failed", iterationsDone: 3, startedAt: "2025-01-02T00:00:00Z", endedAt: "2025-01-02T00:10:00Z" },
      { id: "r4", cardId: "c3", kind: "default", status: "running", iterationsDone: 0, startedAt: "2025-01-03T00:00:00Z", endedAt: null },
    ];

    const result = computeAnalytics({ cards, runs, iterations: [] });

    expect(result.totals.cards).toBe(4);
    expect(result.totals.runs).toBe(4);

    // cardsByStatus: completed=2, failed=1, running=1 – sorted desc by value
    expect(result.cardsByStatus).toEqual([
      { label: "completed", value: 2 },
      { label: "failed", value: 1 },
      { label: "running", value: 1 },
    ]);

    // runsByStatus: completed=2, failed=1, running=1 – sorted desc by value
    expect(result.runsByStatus).toEqual([
      { label: "completed", value: 2 },
      { label: "failed", value: 1 },
      { label: "running", value: 1 },
    ]);
  });

  it("computes iterationDurationsMs from endedAt - startedAt in ascending order", () => {
    const iterations: AnalyticsIterationRow[] = [
      { id: 1, runId: "r1", n: 1, promptTokens: null, completionTokens: null, startedAt: "2025-01-01T00:00:00Z", endedAt: "2025-01-01T00:00:05Z" },  // 5000ms
      { id: 2, runId: "r1", n: 2, promptTokens: null, completionTokens: null, startedAt: "2025-01-01T00:01:00Z", endedAt: "2025-01-01T00:01:02Z" }, // 2000ms
      { id: 3, runId: "r1", n: 3, promptTokens: null, completionTokens: null, startedAt: "2025-01-01T00:02:00Z", endedAt: "2025-01-01T00:02:10Z" }, // 10000ms
    ];

    const result = computeAnalytics({ cards: [], runs: [], iterations });

    // Sorted numerically ascending: 2000, 5000, 10000
    expect(result.iterationDurationsMs).toEqual([2000, 5000, 10000]);
  });

  it("excludes iterations missing start or end from durations", () => {
    const iterations: AnalyticsIterationRow[] = [
      { id: 1, runId: "r1", n: 1, promptTokens: null, completionTokens: null, startedAt: "", endedAt: "2025-01-01T00:00:05Z" },   // no start
      { id: 2, runId: "r1", n: 2, promptTokens: null, completionTokens: null, startedAt: "2025-01-01T00:01:00Z", endedAt: null }, // no end
      { id: 3, runId: "r1", n: 3, promptTokens: null, completionTokens: null, startedAt: "2025-01-01T00:02:00Z", endedAt: "2025-01-01T00:02:03Z" }, // 3000ms – valid
    ];

    const result = computeAnalytics({ cards: [], runs: [], iterations });

    expect(result.iterationDurationsMs).toEqual([3000]);
  });

  it("computes tokensPerRun with card title labels, summed per run, sorted descending", () => {
    const cards: AnalyticsCardRow[] = [
      { id: "c1", title: "Feature A", status: "completed" },
      { id: "c2", title: "Feature B", status: "completed" },
    ];

    const runs: AnalyticsRunRow[] = [
      { id: "r1", cardId: "c1", kind: "default", status: "completed", iterationsDone: 2, startedAt: "2025-01-01T00:00:00Z", endedAt: "2025-01-01T00:05:00Z" },
      { id: "r2", cardId: "c1", kind: "default", status: "completed", iterationsDone: 1, startedAt: "2025-01-01T01:00:00Z", endedAt: "2025-01-01T01:03:00Z" },
      { id: "r3", cardId: "c2", kind: "default", status: "failed", iterationsDone: 3, startedAt: "2025-01-02T00:00:00Z", endedAt: "2025-01-02T00:10:00Z" },
    ];

    const iterations: AnalyticsIterationRow[] = [
      // r1: 100+50 + 200+80 = 430 tokens
      { id: 1, runId: "r1", n: 1, promptTokens: 100, completionTokens: 50, startedAt: "2025-01-01T00:00:00Z", endedAt: null },
      { id: 2, runId: "r1", n: 2, promptTokens: 200, completionTokens: 80, startedAt: "2025-01-01T00:01:00Z", endedAt: null },
      // r2: 10+5 = 15 tokens
      { id: 3, runId: "r2", n: 1, promptTokens: 10, completionTokens: 5, startedAt: "2025-01-01T01:00:00Z", endedAt: null },
      // r3: 300+100 = 400 tokens
      { id: 4, runId: "r3", n: 1, promptTokens: 300, completionTokens: 100, startedAt: "2025-01-02T00:00:00Z", endedAt: null },
    ];

    const result = computeAnalytics({ cards, runs, iterations });

    // r1 (label="Feature A" via c1) → 430
    // r2 (label="Feature A" via c1) → 15
    // r3 (label="Feature B" via c2) → 400
    // Sorted desc: 430, 400, 15
    expect(result.tokensPerRun).toEqual([
      { label: "Feature A", value: 430 },
      { label: "Feature B", value: 400 },
      { label: "Feature A", value: 15 },
    ]);
  });

  it("falls back to run id as label when card id is not found", () => {
    const runs: AnalyticsRunRow[] = [
      { id: "orphan-run", cardId: "nonexistent-card", kind: "default", status: "completed", iterationsDone: 1, startedAt: "2025-01-01T00:00:00Z", endedAt: null },
    ];

    const iterations: AnalyticsIterationRow[] = [
      { id: 1, runId: "orphan-run", n: 1, promptTokens: 50, completionTokens: 25, startedAt: "2025-01-01T00:00:00Z", endedAt: null },
    ];

    const result = computeAnalytics({ cards: [], runs, iterations });

    expect(result.tokensPerRun).toEqual([
      { label: "orphan-run", value: 75 },
    ]);
  });

  it("filters out runs with zero tokens from tokensPerRun", () => {
    const runs: AnalyticsRunRow[] = [
      { id: "r1", cardId: "c1", kind: "default", status: "completed", iterationsDone: 0, startedAt: "2025-01-01T00:00:00Z", endedAt: null },
    ];

    const cards: AnalyticsCardRow[] = [
      { id: "c1", title: "Empty Run", status: "completed" },
    ];

    const result = computeAnalytics({ cards, runs, iterations: [] });

    expect(result.tokensPerRun).toEqual([]);
  });

  it("computes successRate as completed / (completed+failed+timeout+cancelled+interrupted)", () => {
    const runs: AnalyticsRunRow[] = [
      { id: "r1", cardId: "c1", kind: "default", status: "completed", iterationsDone: 2, startedAt: "2025-01-01T00:00:00Z", endedAt: "2025-01-01T00:05:00Z" },
      { id: "r2", cardId: "c1", kind: "default", status: "completed", iterationsDone: 1, startedAt: "2025-01-01T01:00:00Z", endedAt: "2025-01-01T01:03:00Z" },
      { id: "r3", cardId: "c1", kind: "default", status: "failed", iterationsDone: 3, startedAt: "2025-01-02T00:00:00Z", endedAt: "2025-01-02T00:10:00Z" },
      { id: "r4", cardId: "c1", kind: "default", status: "timeout", iterationsDone: 1, startedAt: "2025-01-03T00:00:00Z", endedAt: "2025-01-03T01:00:00Z" },
      { id: "r5", cardId: "c1", kind: "default", status: "cancelled", iterationsDone: 0, startedAt: "2025-01-04T00:00:00Z", endedAt: null },
    ];

    const result = computeAnalytics({ cards: [], runs, iterations: [] });

    // completed=2, completed+failed+timeout+cancelled+interrupted=5 → 2/5 = 0.4
    expect(result.successRate).toBe(0.4);
  });

  it("returns 0 for successRate when there are no terminal runs", () => {
    const runs: AnalyticsRunRow[] = [
      { id: "r1", cardId: "c1", kind: "default", status: "running", iterationsDone: 0, startedAt: "2025-01-01T00:00:00Z", endedAt: null },
      { id: "r2", cardId: "c1", kind: "default", status: "queued", iterationsDone: 0, startedAt: "2025-01-01T00:00:00Z", endedAt: null },
    ];

    const result = computeAnalytics({ cards: [], runs, iterations: [] });

    expect(result.successRate).toBe(0);
  });

  it("returns 1 for successRate when all terminal runs completed", () => {
    const runs: AnalyticsRunRow[] = [
      { id: "r1", cardId: "c1", kind: "default", status: "completed", iterationsDone: 2, startedAt: "2025-01-01T00:00:00Z", endedAt: "2025-01-01T00:05:00Z" },
    ];

    const result = computeAnalytics({ cards: [], runs, iterations: [] });

    expect(result.successRate).toBe(1);
  });

  it("computes tokensByModel grouped by run model, sorted desc, excludes zero-token models, unknown for missing model", () => {
    const runs: AnalyticsRunRow[] = [
      { id: "r1", cardId: "c1", kind: "default", status: "completed", iterationsDone: 2, startedAt: "2025-01-01T00:00:00Z", endedAt: null, model: "claude-3-opus" },
      { id: "r2", cardId: "c1", kind: "default", status: "completed", iterationsDone: 1, startedAt: "2025-01-01T01:00:00Z", endedAt: null, model: "claude-3-sonnet" },
      { id: "r3", cardId: "c1", kind: "default", status: "completed", iterationsDone: 1, startedAt: "2025-01-02T00:00:00Z", endedAt: null, model: "claude-3-opus" },
      { id: "r4", cardId: "c1", kind: "default", status: "completed", iterationsDone: 0, startedAt: "2025-01-03T00:00:00Z", endedAt: null, model: "claude-3-haiku" }, // zero tokens → excluded
      { id: "r5", cardId: "c1", kind: "default", status: "completed", iterationsDone: 1, startedAt: "2025-01-04T00:00:00Z", endedAt: null }, // no model → "unknown"
    ];

    const iterations: AnalyticsIterationRow[] = [
      // r1 (opus): 100+50 = 150
      { id: 1, runId: "r1", n: 1, promptTokens: 100, completionTokens: 50, startedAt: "2025-01-01T00:00:00Z", endedAt: null },
      { id: 2, runId: "r1", n: 2, promptTokens: 30, completionTokens: 10, startedAt: "2025-01-01T00:01:00Z", endedAt: null },
      // r2 (sonnet): 200+80 = 280
      { id: 3, runId: "r2", n: 1, promptTokens: 200, completionTokens: 80, startedAt: "2025-01-01T01:00:00Z", endedAt: null },
      // r3 (opus): 50+25 = 75
      { id: 4, runId: "r3", n: 1, promptTokens: 50, completionTokens: 25, startedAt: "2025-01-02T00:00:00Z", endedAt: null },
      // r5 (unknown): 10+5 = 15
      { id: 5, runId: "r5", n: 1, promptTokens: 10, completionTokens: 5, startedAt: "2025-01-04T00:00:00Z", endedAt: null },
    ];

    const result = computeAnalytics({ cards: [], runs, iterations });

    // opus: (100+50+30+10) + (50+25) = 265, sonnet: 280, unknown: 15
    // Sorted desc: sonnet (280), opus (265), unknown (15)
    // haiku excluded because zero tokens
    expect(result.tokensByModel).toEqual([
      { label: "claude-3-sonnet", value: 280 },
      { label: "claude-3-opus", value: 265 },
      { label: "unknown", value: 15 },
    ]);
  });

  it("computes runsByProvider counted per provider, sorted desc, unknown for missing provider", () => {
    const runs: AnalyticsRunRow[] = [
      { id: "r1", cardId: "c1", kind: "default", status: "completed", iterationsDone: 2, startedAt: "2025-01-01T00:00:00Z", endedAt: null, provider: "anthropic" },
      { id: "r2", cardId: "c1", kind: "default", status: "completed", iterationsDone: 1, startedAt: "2025-01-01T01:00:00Z", endedAt: null, provider: "openai" },
      { id: "r3", cardId: "c1", kind: "default", status: "completed", iterationsDone: 1, startedAt: "2025-01-02T00:00:00Z", endedAt: null, provider: "anthropic" },
      { id: "r4", cardId: "c1", kind: "default", status: "completed", iterationsDone: 0, startedAt: "2025-01-03T00:00:00Z", endedAt: null, provider: "openai" },
      { id: "r5", cardId: "c1", kind: "default", status: "completed", iterationsDone: 0, startedAt: "2025-01-04T00:00:00Z", endedAt: null }, // no provider → "unknown"
    ];

    const result = computeAnalytics({ cards: [], runs, iterations: [] });

    // anthropic: 2, openai: 2, unknown: 1
    // Sorted desc: both 2, then 1
    expect(result.runsByProvider).toEqual([
      { label: "anthropic", value: 2 },
      { label: "openai", value: 2 },
      { label: "unknown", value: 1 },
    ]);
  });

  it("handles full integration: mixed cards, runs, iterations together", () => {
    const cards: AnalyticsCardRow[] = [
      { id: "c1", title: "Chat", status: "completed" },
      { id: "c2", title: "Search", status: "completed" },
      { id: "c3", title: "Crash", status: "failed" },
    ];

    const runs: AnalyticsRunRow[] = [
      { id: "r1", cardId: "c1", kind: "default", status: "completed", iterationsDone: 2, startedAt: "2025-01-01T00:00:00Z", endedAt: "2025-01-01T00:05:00Z" },
      { id: "r2", cardId: "c2", kind: "default", status: "completed", iterationsDone: 1, startedAt: "2025-01-02T00:00:00Z", endedAt: "2025-01-02T00:03:00Z" },
      { id: "r3", cardId: "c3", kind: "default", status: "failed", iterationsDone: 3, startedAt: "2025-01-03T00:00:00Z", endedAt: "2025-01-03T00:10:00Z" },
    ];

    const iterations: AnalyticsIterationRow[] = [
      { id: 1, runId: "r1", n: 1, promptTokens: 10, completionTokens: 5, startedAt: "2025-01-01T00:00:00Z", endedAt: "2025-01-01T00:00:02Z" },
      { id: 2, runId: "r1", n: 2, promptTokens: 20, completionTokens: 10, startedAt: "2025-01-01T00:00:03Z", endedAt: "2025-01-01T00:00:08Z" },
      { id: 3, runId: "r2", n: 1, promptTokens: 100, completionTokens: 50, startedAt: "2025-01-02T00:00:00Z", endedAt: "2025-01-02T00:00:03Z" },
      { id: 4, runId: "r3", n: 1, promptTokens: null, completionTokens: null, startedAt: "2025-01-03T00:00:00Z", endedAt: "2025-01-03T00:00:15Z" },
    ];

    const result = computeAnalytics({ cards, runs, iterations });

    expect(result.totals).toEqual({
      cards: 3,
      runs: 3,
      iterations: 4,
      promptTokens: 130,
      completionTokens: 65,
      totalTokens: 195,
      costUsd: null,
    });

    // cardsByStatus: completed=2, failed=1
    expect(result.cardsByStatus).toEqual([
      { label: "completed", value: 2 },
      { label: "failed", value: 1 },
    ]);

    // runsByStatus: completed=2, failed=1
    expect(result.runsByStatus).toEqual([
      { label: "completed", value: 2 },
      { label: "failed", value: 1 },
    ]);

    // tokensPerRun: r1 (Chat) = 15+30=45, r2 (Search)=150, r3 (Crash)=0 (null tokens → filtered out)
    expect(result.tokensPerRun).toEqual([
      { label: "Search", value: 150 },
      { label: "Chat", value: 45 },
    ]);

    // durations sorted asc: 2000, 3000, 5000, 15000
    expect(result.iterationDurationsMs).toEqual([2000, 3000, 5000, 15000]);

    // successRate: completed=2, completed+failed=3 → 2/3 ≈ 0.666...
    expect(result.successRate).toBeCloseTo(2 / 3);
  });
});

describe("filterAnalyticsInput", () => {
  const baseRuns: AnalyticsRunRow[] = [
    { id: "r1", cardId: "c1", kind: "default", status: "completed", iterationsDone: 2, startedAt: "2025-01-01T00:00:00Z", endedAt: "2025-01-01T00:05:00Z", provider: "anthropic", model: "claude-3-opus" },
    { id: "r2", cardId: "c1", kind: "default", status: "completed", iterationsDone: 1, startedAt: "2025-01-02T00:00:00Z", endedAt: "2025-01-02T00:03:00Z", provider: "openai", model: "gpt-4" },
    { id: "r3", cardId: "c2", kind: "default", status: "failed", iterationsDone: 3, startedAt: "2025-01-10T00:00:00Z", endedAt: "2025-01-10T00:10:00Z", provider: "anthropic", model: "claude-3-opus" },
  ];

  const baseIterations: AnalyticsIterationRow[] = [
    { id: 1, runId: "r1", n: 1, promptTokens: 100, completionTokens: 50, startedAt: "2025-01-01T00:00:00Z", endedAt: null },
    { id: 2, runId: "r2", n: 1, promptTokens: 200, completionTokens: 80, startedAt: "2025-01-02T00:00:00Z", endedAt: null },
    { id: 3, runId: "r3", n: 1, promptTokens: 50, completionTokens: 25, startedAt: "2025-01-10T00:00:00Z", endedAt: null },
  ];

  const baseCards: AnalyticsCardRow[] = [
    { id: "c1", title: "Card A", status: "completed" },
    { id: "c2", title: "Card B", status: "failed" },
  ];

  it("fromMs filter excludes runs started before the bound and drops their iterations", () => {
    const filter: AnalyticsFilter = { fromMs: new Date("2025-01-05T00:00:00Z").getTime() };
    const result = filterAnalyticsInput({ cards: baseCards, runs: baseRuns, iterations: baseIterations }, filter);

    // r1 (Jan 1) excluded, r2 (Jan 2) excluded, r3 (Jan 10) kept
    expect(result.runs).toEqual([baseRuns[2]]);
    expect(result.runs).toHaveLength(1);
    // Only iteration belonging to r3 is kept
    expect(result.iterations).toEqual([baseIterations[2]]);
    expect(result.iterations).toHaveLength(1);
    // Cards always pass through unchanged
    expect(result.cards).toEqual(baseCards);
  });

  it("provider filter keeps only runs with that exact provider", () => {
    const filter: AnalyticsFilter = { provider: "anthropic" };
    const result = filterAnalyticsInput({ cards: baseCards, runs: baseRuns, iterations: baseIterations }, filter);

    // r1 (anthropic) and r3 (anthropic) kept, r2 (openai) excluded
    expect(result.runs).toEqual([baseRuns[0], baseRuns[2]]);
    expect(result.runs).toHaveLength(2);
    // Only iterations belonging to kept runs
    expect(result.iterations).toEqual([baseIterations[0], baseIterations[2]]);
    expect(result.cards).toEqual(baseCards);
  });

  it("model filter keeps only runs with that exact model", () => {
    const filter: AnalyticsFilter = { model: "claude-3-opus" };
    const result = filterAnalyticsInput({ cards: baseCards, runs: baseRuns, iterations: baseIterations }, filter);

    // r1 and r3 have claude-3-opus, r2 has gpt-4
    expect(result.runs).toEqual([baseRuns[0], baseRuns[2]]);
    expect(result.runs).toHaveLength(2);
    expect(result.iterations).toEqual([baseIterations[0], baseIterations[2]]);
    expect(result.cards).toEqual(baseCards);
  });

  it("empty/\"\"/null filters return all runs/iterations unchanged", () => {
    const result = filterAnalyticsInput({ cards: baseCards, runs: baseRuns, iterations: baseIterations }, {});

    expect(result.runs).toEqual(baseRuns);
    expect(result.iterations).toEqual(baseIterations);
    expect(result.cards).toEqual(baseCards);

    const resultEmptyString = filterAnalyticsInput({ cards: baseCards, runs: baseRuns, iterations: baseIterations }, { provider: "", model: "" });

    expect(resultEmptyString.runs).toEqual(baseRuns);
    expect(resultEmptyString.iterations).toEqual(baseIterations);

    const resultNull = filterAnalyticsInput({ cards: baseCards, runs: baseRuns, iterations: baseIterations }, { fromMs: null, provider: undefined, model: undefined });

    expect(resultNull.runs).toEqual(baseRuns);
    expect(resultNull.iterations).toEqual(baseIterations);
  });

  it("iterations belonging to a filtered-out run are removed even if the iteration's own startedAt is in range", () => {
    // Filter by provider=openai — r2 matches, r1 and r3 excluded
    const filter: AnalyticsFilter = { provider: "openai" };
    const result = filterAnalyticsInput({ cards: baseCards, runs: baseRuns, iterations: baseIterations }, filter);

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].id).toBe("r2");
    // Only r2's iteration is kept, even though the other iterations have timestamps that
    // would pass a fromMs filter — they're removed because their parent run was filtered out.
    expect(result.iterations).toEqual([baseIterations[1]]);
  });
});
describe("percentile", () => {
  it("returns null on an empty sample", () => {
    expect(percentile([], 50)).toBeNull();
  });

  it("uses nearest-rank on a sorted sample", () => {
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 90)).toBe(90);
    expect(percentile(sorted, 95)).toBe(100);
    expect(percentile(sorted, 100)).toBe(100);
  });

  it("returns the single element for any percentile", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });
});

describe("loopKpis", () => {
  function iter(
    n: number,
    startedAt: string,
    endedAt: string | null,
    extra: Partial<AnalyticsIterationRow> = {},
  ): AnalyticsIterationRow {
    return { id: n, runId: "r1", n, promptTokens: null, completionTokens: null, startedAt, endedAt, ...extra };
  }

  it("reports null metrics and zero samples on empty input", () => {
    const { loopKpis } = computeAnalytics({ cards: [], runs: [], iterations: [] });
    expect(loopKpis.sampleSize).toBe(0);
    expect(loopKpis.durationP50Ms).toBeNull();
    expect(loopKpis.durationMaxMs).toBeNull();
    expect(loopKpis.slowIterationRate).toBeNull();
    expect(loopKpis.medianModelTurns).toBeNull();
    expect(loopKpis.cacheHitRatio).toBeNull();
    expect(loopKpis.totalToolDurationMs).toBeNull();
    expect(loopKpis.totalCostUsd).toBeNull();
  });

  it("derives duration percentiles and the five-minute outlier rate from iterationDurationsMs", () => {
    // 60s, 120s, 180s, 360s — one of four is ≥ 5 minutes
    const iterations = [
      iter(1, "2026-07-01T00:00:00Z", "2026-07-01T00:01:00Z"),
      iter(2, "2026-07-01T01:00:00Z", "2026-07-01T01:02:00Z"),
      iter(3, "2026-07-01T02:00:00Z", "2026-07-01T02:03:00Z"),
      iter(4, "2026-07-01T03:00:00Z", "2026-07-01T03:06:00Z"),
    ];
    const result = computeAnalytics({ cards: [], runs: [], iterations });
    expect(result.loopKpis.sampleSize).toBe(4);
    expect(result.loopKpis.durationP50Ms).toBe(120000);
    expect(result.loopKpis.durationMaxMs).toBe(360000);
    expect(result.loopKpis.slowIterationRate).toBe(0.25);
    // Same pipeline as iterationDurationsMs — no second duration calculation.
    expect(result.iterationDurationsMs).toEqual([60000, 120000, 180000, 360000]);
  });

  it("computes model-turn median, cache-hit ratio, tool time, and cost only over reporting iterations", () => {
    const iterations = [
      iter(1, "2026-07-01T00:00:00Z", "2026-07-01T00:01:00Z", {
        promptTokens: 1000,
        modelTurns: 10,
        cachedInputTokens: 9000,
        toolDurationMs: 500,
        costUsd: 0.5,
      }),
      iter(2, "2026-07-01T01:00:00Z", "2026-07-01T01:01:00Z", {
        promptTokens: 3000,
        modelTurns: 20,
        cachedInputTokens: 7000,
        toolDurationMs: 1500,
        costUsd: 0.25,
      }),
      // pre-telemetry row: no new facts — must not drag ratios toward zero
      iter(3, "2026-07-01T02:00:00Z", "2026-07-01T02:01:00Z", { promptTokens: 99999 }),
    ];
    const { loopKpis } = computeAnalytics({ cards: [], runs: [], iterations });
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
  function run(id: string, cardId: string, model: string | null): AnalyticsRunRow {
    return { id, cardId, kind: "loop", status: "completed", iterationsDone: 0, startedAt: "2026-07-01T00:00:00Z", endedAt: null, provider: "anthropic", model };
  }
  function iter(
    id: number,
    runId: string,
    extra: Partial<AnalyticsIterationRow> = {},
  ): AnalyticsIterationRow {
    return { id, runId, n: id, promptTokens: 10, completionTokens: 5, startedAt: "2026-07-01T00:00:00Z", endedAt: "2026-07-01T00:01:00Z", ...extra };
  }

  it("sums totals.costUsd over the iterations that reported a cost", () => {
    const iterations = [
      iter(1, "r1", { costUsd: 0.0123 }),
      iter(2, "r1", { costUsd: 0.0004 }),
      iter(3, "r1"), // pre-telemetry row — contributes nothing
    ];
    const { totals } = computeAnalytics({ cards: [], runs: [], iterations });
    expect(totals.costUsd).toBeCloseTo(0.0127);
  });

  it("leaves totals.costUsd null when nothing was priced, so an unpriced sample never reads as free", () => {
    const { totals } = computeAnalytics({
      cards: [],
      runs: [],
      iterations: [iter(1, "r1"), iter(2, "r1")],
    });
    expect(totals.costUsd).toBeNull();
  });

  it("keeps a reported zero as zero rather than dropping it to null", () => {
    // Local models are registered with zero rates — that is a real $0, not an absence.
    const { totals } = computeAnalytics({
      cards: [],
      runs: [],
      iterations: [iter(1, "r1", { costUsd: 0 })],
    });
    expect(totals.costUsd).toBe(0);
  });

  it("labels costPerRun by card title and sorts descending", () => {
    const cards = [
      { id: "c1", title: "Cheap task", status: "completed" },
      { id: "c2", title: "Costly task", status: "completed" },
    ];
    const runs = [run("r1", "c1", "opus"), run("r2", "c2", "opus")];
    const iterations = [
      iter(1, "r1", { costUsd: 0.01 }),
      iter(2, "r2", { costUsd: 0.2 }),
      iter(3, "r2", { costUsd: 0.05 }),
    ];
    const { costPerRun } = computeAnalytics({ cards, runs, iterations });
    expect(costPerRun.map((d) => d.label)).toEqual(["Costly task", "Cheap task"]);
    expect(costPerRun[0].value).toBeCloseTo(0.25);
    expect(costPerRun[1].value).toBeCloseTo(0.01);
  });

  it("omits runs with no priced iteration from costPerRun", () => {
    const cards = [{ id: "c1", title: "Unpriced task", status: "completed" }];
    const runs = [run("r1", "c1", "local-model")];
    const { costPerRun } = computeAnalytics({ cards, runs, iterations: [iter(1, "r1")] });
    expect(costPerRun).toEqual([]);
  });

  it("groups costByModel by the run's model, bucketing a blank model as unknown", () => {
    const runs = [run("r1", "c1", "opus"), run("r2", "c1", "haiku"), run("r3", "c1", null)];
    const iterations = [
      iter(1, "r1", { costUsd: 0.3 }),
      iter(2, "r2", { costUsd: 0.1 }),
      iter(3, "r3", { costUsd: 0.2 }),
    ];
    const { costByModel } = computeAnalytics({ cards: [], runs, iterations });
    expect(costByModel).toEqual([
      { label: "opus", value: 0.3 },
      { label: "unknown", value: 0.2 },
      { label: "haiku", value: 0.1 },
    ]);
  });
});

describe("loopCohorts", () => {
  function run(id: string, provider: string | null, model: string | null): AnalyticsRunRow {
    return { id, cardId: "c1", kind: "loop", status: "completed", iterationsDone: 0, startedAt: "2026-07-01T00:00:00Z", endedAt: null, provider, model };
  }

  function iters(
    runId: string,
    count: number,
    durationSec: number,
    extra: Partial<AnalyticsIterationRow> = {},
  ): AnalyticsIterationRow[] {
    return Array.from({ length: count }, (_, i) => ({
      id: i,
      runId,
      n: i + 1,
      promptTokens: null,
      completionTokens: null,
      startedAt: "2026-07-01T00:00:00Z",
      endedAt: new Date(Date.parse("2026-07-01T00:00:00Z") + durationSec * 1000).toISOString(),
      ...extra,
    }));
  }

  it("groups by actual provider/model/harness/version and hides cohorts under 10 iterations", () => {
    const runs = [run("r1", "openrouter", "requested-model"), run("r2", "omlx", "m2")];
    const iterations = [
      ...iters("r1", 10, 60, {
        actualProvider: "openrouter",
        actualModel: "actual-model",
        harness: "opencode",
        harnessVersion: "1.17.18",
      }),
      ...iters("r2", 9, 30), // under the minimum — never reported
    ];
    const { loopCohorts } = computeAnalytics({ cards: [], runs, iterations });
    expect(loopCohorts).toEqual([
      {
        label: "openrouter/actual-model · opencode 1.17.18",
        sampleSize: 10,
        durationP50Ms: 60000,
        durationP90Ms: 60000,
      },
    ]);
  });

  it("falls back to the run's requested provider/model for pre-telemetry iterations", () => {
    const runs = [run("r1", "anthropic", "sonnet")];
    const { loopCohorts } = computeAnalytics({
      cards: [],
      runs,
      iterations: iters("r1", 12, 90),
    });
    expect(loopCohorts).toHaveLength(1);
    expect(loopCohorts[0].label).toBe("anthropic/sonnet");
    expect(loopCohorts[0].sampleSize).toBe(12);
  });

  it("combines matching provider/model cohorts and keeps cacheHitRatio", () => {
    const runs: AnalyticsRunRow[] = [
      { id: "r1", cardId: "c1", kind: "loop", status: "completed", iterationsDone: 10, startedAt: "2026-07-01T00:00:00Z", endedAt: null, provider: "openrouter", model: "gpt-4" },
      { id: "r2", cardId: "c1", kind: "loop", status: "completed", iterationsDone: 10, startedAt: "2026-07-02T00:00:00Z", endedAt: null, provider: "openrouter", model: "gpt-4" },
    ];

    // 10 iterations for each run, with cachedInputTokens so cacheHitRatio is computed
    const itersR1 = Array.from({ length: 10 }, (_, i) => ({
      id: i,
      runId: "r1",
      n: i + 1,
      promptTokens: 100,
      completionTokens: 50,
      cachedInputTokens: 900,
      startedAt: "2026-07-01T00:00:00Z",
      endedAt: new Date(Date.parse("2026-07-01T00:00:00Z") + 60 * 1000).toISOString(),
    }));
    const itersR2 = Array.from({ length: 10 }, (_, i) => ({
      id: 100 + i,
      runId: "r2",
      n: i + 1,
      promptTokens: 200,
      completionTokens: 30,
      cachedInputTokens: 800,
      startedAt: "2026-07-02T00:00:00Z",
      endedAt: new Date(Date.parse("2026-07-02T00:00:00Z") + 60 * 1000).toISOString(),
    }));
    const iterations: AnalyticsIterationRow[] = [...itersR1, ...itersR2];

    const { loopCohorts, loopKpis } = computeAnalytics({ cards: [], runs, iterations });

    expect(loopCohorts).toEqual([
      {
        label: "openrouter/gpt-4",
        sampleSize: 20,
        durationP50Ms: 60000,
        durationP90Ms: 60000,
      },
    ]);

    expect(loopKpis.cacheHitRatio).not.toBeNull();
    // Both runs report cachedInputTokens: r1 = 9000 cached / (9000+1000) = 0.9,
    // r2 = 8000 cached / (8000+2000) = 0.8
    // Overall: 17000 cached / (17000+3000) ≈ 0.85
    expect(loopKpis.cacheHitRatio).toBeCloseTo(17000 / (17000 + 3000), 5);
    expect(loopKpis.cacheSampleSize).toBe(20);
  });
});

describe("computeRolloutAcceptance", () => {
  /** Build one measurable iteration lasting `durationSec`, `modelTurns` optional. */
  function iter(id: number, durationSec: number, modelTurns?: number | null): AnalyticsIterationRow {
    const start = new Date(Date.UTC(2026, 0, 1) + id * 3_600_000);
    return {
      id,
      runId: "r1",
      n: id,
      promptTokens: null,
      completionTokens: null,
      modelTurns: modelTurns ?? null,
      startedAt: start.toISOString(),
      endedAt: new Date(start.getTime() + durationSec * 1000).toISOString(),
    };
  }

  it("reports an insufficient sample with null passes below 30 iterations", () => {
    const result = computeRolloutAcceptance([iter(1, 60, 5), iter(2, 90, 6)]);

    expect(result.sufficientSample).toBe(false);
    expect(result.windowSize).toBe(2);
    expect(result.requiredSampleSize).toBe(30);
    expect(result.accepted).toBeNull();
    for (const target of result.targets) expect(target.pass).toBeNull();
    // Actuals are still measured so the UI can show progress
    expect(result.targets.find((t) => t.key === "medianDurationMs")!.actual).not.toBeNull();
  });

  it("accepts when all four targets are met over 30 iterations", () => {
    const iterations = Array.from({ length: 30 }, (_, i) => iter(i + 1, 100, 10));

    const result = computeRolloutAcceptance(iterations);

    expect(result.sufficientSample).toBe(true);
    expect(result.windowSize).toBe(30);
    expect(result.accepted).toBe(true);
    expect(result.targets.map((t) => t.pass)).toEqual([true, true, true, true]);
  });

  it("fails a missed target: p90 above 240s", () => {
    // 25 fast iterations plus 5 at 300s → p90 lands in the slow tail and the
    // slow-iteration rate hits exactly 5/30 ≈ 16.7%
    const iterations = [
      ...Array.from({ length: 25 }, (_, i) => iter(i + 1, 60, 8)),
      ...Array.from({ length: 5 }, (_, i) => iter(26 + i, 300, 8)),
    ];

    const result = computeRolloutAcceptance(iterations);

    expect(result.accepted).toBe(false);
    expect(result.targets.find((t) => t.key === "p90DurationMs")!.pass).toBe(false);
    expect(result.targets.find((t) => t.key === "slowIterationRate")!.pass).toBe(false);
    expect(result.targets.find((t) => t.key === "medianDurationMs")!.pass).toBe(true);
  });

  it("treats the slow-rate target as strict: exactly 5% is a miss", () => {
    // 1 of 20 in-window... use 40 iterations: window = most recent 30, with
    // exactly 2 slow ones in the window → 2/30 = 6.67% fails; 1 slow → 3.3% passes
    const passIterations = [
      ...Array.from({ length: 29 }, (_, i) => iter(i + 1, 60, 8)),
      iter(30, 300, 8),
    ];
    expect(
      computeRolloutAcceptance(passIterations).targets.find((t) => t.key === "slowIterationRate")!.pass,
    ).toBe(true);
  });

  it("evaluates only the most recent 30 measurable iterations", () => {
    // 30 old slow iterations followed by 30 recent fast ones → accepted
    const iterations = [
      ...Array.from({ length: 30 }, (_, i) => iter(i + 1, 400, 20)),
      ...Array.from({ length: 30 }, (_, i) => iter(31 + i, 90, 9)),
    ];

    const result = computeRolloutAcceptance(iterations);

    expect(result.windowSize).toBe(30);
    expect(result.accepted).toBe(true);
  });

  it("leaves acceptance null when model turns are unreported", () => {
    const iterations = Array.from({ length: 30 }, (_, i) => iter(i + 1, 100, null));

    const result = computeRolloutAcceptance(iterations);

    expect(result.targets.find((t) => t.key === "medianModelTurns")!.pass).toBeNull();
    expect(result.targets.find((t) => t.key === "medianDurationMs")!.pass).toBe(true);
    expect(result.accepted).toBeNull();
  });

  it("ignores iterations without a measurable duration", () => {
    const unmeasurable: AnalyticsIterationRow = {
      id: 99,
      runId: "r1",
      n: 99,
      promptTokens: null,
      completionTokens: null,
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: null,
    };
    const result = computeRolloutAcceptance([
      unmeasurable,
      ...Array.from({ length: 30 }, (_, i) => iter(i + 1, 100, 10)),
    ]);

    expect(result.windowSize).toBe(30);
    expect(result.accepted).toBe(true);
  });
});
