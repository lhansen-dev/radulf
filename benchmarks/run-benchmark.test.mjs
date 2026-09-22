import { describe, it, expect } from "vitest";
import { selectReviewRun, aggregateTokens, percentile } from "./run-benchmark.mjs";

// A card is a plan run plus one or more loop → evaluate cycles. `card.latestRun`
// is whichever run finished last, which after a normal pipeline (or a
// revise-triggered extra cycle) is the *evaluate* run — zero iterations, zero
// tokens, and rejected by POST /api/reviews. This is the bug the runner used
// to have: measuring `latestRun` instead of the newest completed loop.

const evaluateRun = (id, overrides = {}) => ({ id, kind: "evaluate", status: "completed", ...overrides });
const loopRun = (id, overrides = {}) => ({ id, kind: "loop", status: "completed", ...overrides });
const planRun = (id, overrides = {}) => ({ id, kind: "plan", status: "completed", ...overrides });

describe("selectReviewRun", () => {
  it("picks the newest completed loop run, not card.latestRun", () => {
    // Newest-first: evaluate → loop → evaluate → loop → plan
    const cardRuns = [
      evaluateRun("r5"),
      loopRun("r4"),
      evaluateRun("r3"),
      loopRun("r2"),
      planRun("r1"),
    ];

    expect(selectReviewRun(cardRuns)).toEqual(loopRun("r4"));
  });

  it("ignores unfinished loop runs, returning null when no completed one exists", () => {
    expect(selectReviewRun([loopRun("r2", { status: "running" }), loopRun("r1")])).toEqual(loopRun("r1"));
    expect(selectReviewRun([loopRun("r2", { status: "running" }), evaluateRun("r1")])).toBeNull();
  });
});

describe("aggregateTokens", () => {
  it("sums tokens and cost across every run on the card, not just the reviewed one", () => {
    // Same evaluate → loop → evaluate → loop → plan shape, each with its own
    // iterations. Only loop runs have iterations in practice, but the sum
    // must cover the whole card, and costByKind must break down by role.
    const runDetails = [
      { run: evaluateRun("r5"), iterations: [] },
      {
        run: loopRun("r4"),
        iterations: [
          { promptTokens: 100, completionTokens: 50, costUsd: 0.02, modelTurns: 2 },
          { promptTokens: 200, completionTokens: 80, costUsd: 0.03, modelTurns: 3 },
        ],
      },
      { run: evaluateRun("r3"), iterations: [] },
      {
        run: loopRun("r2"),
        iterations: [{ promptTokens: 150, completionTokens: 60, costUsd: 0.025, modelTurns: 2 }],
      },
      { run: planRun("r1"), iterations: [] },
    ];

    const agg = aggregateTokens(runDetails);

    expect(agg.sumPromptTokens).toBe(450);
    expect(agg.sumCompletionTokens).toBe(190);
    expect(agg.totalModelTurns).toBe(7);
    expect(agg.sumCostUsd).toBeCloseTo(0.075, 10);
    expect(agg.loopIterations).toHaveLength(3);
    expect(agg.allIterations).toHaveLength(3);
    expect(agg.costByKind.evaluate).toBe(0);
    expect(agg.costByKind.plan).toBe(0);
    expect(agg.costByKind.loop).toBeCloseTo(0.075, 10);
  });

  it("treats missing iteration fields, or a missing iterations key, as zero", () => {
    expect(aggregateTokens([{ run: loopRun("r1"), iterations: [{}] }])).toMatchObject({
      sumPromptTokens: 0,
      sumCostUsd: 0,
    });
    expect(aggregateTokens([{ run: planRun("r1") }])).toMatchObject({
      allIterations: [],
      loopIterations: [],
      sumCostUsd: 0,
    });
  });

  it("prefers the run's own telemetry roll-up over summing iterations — plan/evaluate have no iterations at all", () => {
    // Before the runs-table telemetry migration, plan and evaluate runs had
    // no iteration rows, so costByKind always reported 0 for both — the bug
    // this fixes. Now the run row itself carries the numbers.
    const runDetails = [
      {
        run: planRun("r1", { promptTokens: 500, completionTokens: 100, costUsd: 0.7 }),
        iterations: [],
      },
      {
        run: loopRun("r2", { promptTokens: 200, completionTokens: 50, costUsd: 0.2 }),
        iterations: [{ promptTokens: 999, completionTokens: 999, costUsd: 999 }], // ignored: run-level wins
      },
      {
        run: evaluateRun("r3", { promptTokens: 100, completionTokens: 20, costUsd: 0.1 }),
        iterations: [],
      },
    ];

    const agg = aggregateTokens(runDetails);

    expect(agg.sumPromptTokens).toBe(800);
    expect(agg.sumCompletionTokens).toBe(170);
    expect(agg.sumCostUsd).toBeCloseTo(1.0, 10);
    expect(agg.costByKind).toEqual({ plan: 0.7, loop: 0.2, evaluate: 0.1 });
  });

  it("falls back to summing iterations for a run predating the telemetry migration", () => {
    const runDetails = [
      {
        run: loopRun("r1"), // no run-level promptTokens/costUsd
        iterations: [
          { promptTokens: 10, completionTokens: 5, costUsd: 0.01 },
          { promptTokens: 20, completionTokens: 10, costUsd: 0.02 },
        ],
      },
    ];

    const agg = aggregateTokens(runDetails);

    expect(agg.sumPromptTokens).toBe(30);
    expect(agg.sumCompletionTokens).toBe(15);
    expect(agg.sumCostUsd).toBeCloseTo(0.03, 10);
  });
});

describe("percentile", () => {
  it("uses nearest rank, like the analytics tab, rather than interpolating", () => {
    // Interpolation would report 2.5 and 9.1 here; nearest rank returns an
    // observed value, and the analytics tab computes the same one.
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([7], 90)).toBe(7);
    expect(percentile([], 50)).toBe(0);
  });
});
