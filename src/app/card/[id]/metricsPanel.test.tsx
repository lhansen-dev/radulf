// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
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
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders a completed run with a concrete total duration", () => {
    const run = makeRun();
    render(<MetricsPanel run={run} />);

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

  it("renders a running run with live ticking total and iteration durations", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

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
    render(<MetricsPanel run={run} />);

    // Initially the iteration row and Total row both show "0s"
    // (startedAt = now, so 0 seconds elapsed)
    const zeroCells = screen.getAllByText("0s");
    expect(zeroCells.length).toBe(2);

    // Advance timers by 2 seconds — both should now show "2s"
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    const twoCells = screen.getAllByText("2s");
    expect(twoCells.length).toBe(2);

    // Advance by another second — both should show "3s"
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    const threeCells = screen.getAllByText("3s");
    expect(threeCells.length).toBe(2);
  });
});