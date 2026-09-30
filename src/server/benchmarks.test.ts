import { describe, it, expect } from "vitest";
import { listFixtures, summarizeReport } from "./benchmarks";

describe("listFixtures", () => {
  // Runs against the real benchmarks/ directory — the corpus is part of the repo.
  it("finds the four corpus fixtures with titles and criteria", () => {
    const fixtures = listFixtures();
    const names = fixtures.map((f) => f.name);

    expect(names).toEqual([
      "failing-test-repair",
      "server-data-change",
      "small-ui-change",
      "snake-tui",
    ]);
    for (const f of fixtures) {
      expect(f.title.length).toBeGreaterThan(0);
      expect(f.criteriaCount).toBeGreaterThan(0);
      // Existing-codebase fixtures are seeded; snake-tui is greenfield.
      expect(f.seeded).toBe(f.name !== "snake-tui");
    }
  });

  it("returns an empty list for a missing directory", () => {
    expect(listFixtures("/nonexistent/benchmarks")).toEqual([]);
  });
});

describe("summarizeReport", () => {
  it("extracts meta and aggregated medians from a runner report", () => {
    const summary = summarizeReport("f.json", {
      meta: {
        fixture: "snake-tui",
        provider: "openrouter",
        model: "some/model",
        plannerModel: "planner/model",
        numRuns: 3,
        timestamp: "2026-07-15T00:00:00.000Z",
      },
      aggregated: {
        totalWallTimeMs: { median: 120000 },
        iterationCount: { median: 8 },
        totalModelTurns: { median: 90 },
        sumCostUsd: { median: 1.25 },
        criteriaPassRate: 1,
        diffCorrectnessRate: 2 / 3,
      },
    });

    expect(summary).toEqual({
      file: "f.json",
      fixture: "snake-tui",
      provider: "openrouter",
      model: "some/model",
      plannerModel: "planner/model",
      numRuns: 3,
      timestamp: "2026-07-15T00:00:00.000Z",
      error: null,
      criteriaPassRate: 1,
      diffCorrectnessRate: 2 / 3,
      medianWallTimeMs: 120000,
      medianIterations: 8,
      medianModelTurns: 90,
      medianCostUsd: 1.25,
    });
  });

  it("uses the loop model as the planner for legacy reports", () => {
    const summary = summarizeReport("legacy.json", {
      meta: { model: "one/model" },
    });
    expect(summary.plannerModel).toBe("one/model");
  });

  it("tolerates a malformed or empty report", () => {
    const summary = summarizeReport("bad.json", null);
    expect(summary.file).toBe("bad.json");
    expect(summary.fixture).toBeNull();
    expect(summary.criteriaPassRate).toBeNull();
    expect(summary.medianWallTimeMs).toBeNull();
    expect(summary.error).toBeNull();
  });

  it("surfaces the runner's fatal error from a failure report", () => {
    const summary = summarizeReport("failed.json", {
      meta: {
        fixture: "snake-tui",
        provider: "openrouter",
        model: "some/model",
        numRuns: 3,
        timestamp: "2026-07-15T00:00:00.000Z",
        error: "git checkout -q main exited 1",
      },
    });
    expect(summary.fixture).toBe("snake-tui");
    expect(summary.error).toBe("git checkout -q main exited 1");
    expect(summary.criteriaPassRate).toBeNull();
  });
});
