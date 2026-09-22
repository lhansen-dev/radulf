// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MetricsPanel, Run } from "./metricsPanel";

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    kind: "loop",
    status: "completed",
    iterationsDone: 2,
    exitReason: null,
    startedAt: "2025-01-01T00:00:00Z",
    endedAt: "2025-01-01T00:00:02Z",
    iterations: [
      {
        id: 1,
        runId: "run-1",
        n: 1,
        status: "completed",
        summary: null,
        promptTokens: 50,
        completionTokens: 100,
        startedAt: "2025-01-01T00:00:00Z",
        endedAt: "2025-01-01T00:00:01Z",
      },
      {
        id: 2,
        runId: "run-1",
        n: 2,
        status: "completed",
        summary: null,
        promptTokens: 30,
        completionTokens: 60,
        startedAt: "2025-01-01T00:00:01Z",
        endedAt: "2025-01-01T00:00:02Z",
      },
    ],
    ...overrides,
  };
}

describe("MetricsPanel", () => {
  afterEach(cleanup);

  it("renders a completed run with a concrete total duration", () => {
    const run = makeRun();
    render(<MetricsPanel run={run} nowMs={Date.now()} />);

    // Total row should show the duration of the whole run
    // Started at 00:00:00, ended at 00:00:02 => "2s"
    expect(screen.getByText("2s")).toBeTruthy();

    // Each iteration should show its own duration (both are 1s)
    const durations = screen.getAllByText("1s");
    expect(durations.length).toBe(2);

    // Should show token totals: 50+30=80 prompt, 100+60=160 completion
    expect(screen.getByText("80")).toBeTruthy();
    expect(screen.getByText("160")).toBeTruthy();
  });

  it("follows the clock it is handed for a running run's total and iteration durations", () => {
    const start = new Date("2025-01-01T00:00:00Z").getTime();
    const run = makeRun({
      status: "running",
      endedAt: null,
      iterations: [
        {
          id: 1,
          runId: "run-1",
          n: 1,
          status: "running",
          summary: null,
          promptTokens: 50,
          completionTokens: 100,
          startedAt: "2025-01-01T00:00:00Z",
          endedAt: null,
        },
      ],
    });
    const { rerender } = render(<MetricsPanel run={run} nowMs={start} />);

    // The iteration row and Total row both show "0s" at the start.
    expect(screen.getAllByText("0s")).toHaveLength(2);

    // The RunsTable's clock moves on 2 seconds — both show "2s".
    rerender(<MetricsPanel run={run} nowMs={start + 2000} />);
    expect(screen.getAllByText("2s")).toHaveLength(2);

    rerender(<MetricsPanel run={run} nowMs={start + 3000} />);
    expect(screen.getAllByText("3s")).toHaveLength(2);
  });

  it("renders unmeasured tokens as em dash and totals only what was reported", () => {
    const run = makeRun();
    run.iterations[1].promptTokens = null;
    run.iterations[1].completionTokens = null;
    render(<MetricsPanel run={run} nowMs={Date.now()} />);

    // Row 2's two token cells, plus the three unpriced cost cells.
    expect(screen.getAllByText("—")).toHaveLength(5);
    // The totals are the one measured row's numbers, not that row plus zero.
    expect(screen.getAllByText("50")).toHaveLength(2);
    expect(screen.getAllByText("100")).toHaveLength(2);
  });

  it("shows per-iteration cost, totaling only what was priced", () => {
    const run = makeRun();
    run.iterations[0].costUsd = 0.0123;
    run.iterations[1].costUsd = 0.0004;
    const { rerender } = render(<MetricsPanel run={run} nowMs={Date.now()} />);
    expect(screen.getByText("$0.0123")).toBeTruthy();
    expect(screen.getByText("$0.0004")).toBeTruthy();
    expect(screen.getByText("$0.0127")).toBeTruthy();

    // A pre-telemetry row is an em dash, and the total covers only the priced one.
    const partlyPriced = makeRun();
    partlyPriced.iterations[0].costUsd = 0.05;
    rerender(<MetricsPanel run={partlyPriced} nowMs={Date.now()} />);
    expect(screen.getAllByText("—")).toHaveLength(1);
    expect(screen.getAllByText("$0.0500")).toHaveLength(2);

    // Nothing priced: both rows and the total are em dashes, never $0.
    rerender(<MetricsPanel run={makeRun()} nowMs={Date.now()} />);
    expect(screen.getAllByText("—")).toHaveLength(3);
  });
});