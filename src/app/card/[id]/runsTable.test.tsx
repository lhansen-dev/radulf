// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RunsTable } from "./runsTable";
import { runTotals } from "./runTotals";
import type { Run } from "./metricsPanel";
import type { CardDetailData, Plan } from "./useCardDetail";

const models: CardDetailData["models"] = {
  planner: { provider: "anthropic", model: "opus", reasoningLevel: "high" },
  loop: { provider: "anthropic", model: "sonnet", reasoningLevel: "medium" },
  evaluator: { provider: "anthropic", model: "opus", reasoningLevel: "high" },
};

const plan: Plan = {
  id: "p1",
  version: 2,
  planMd: "## Tasks",
  promptMd: "",
  acceptanceCriteria: "- the table totals every run",
  feedback: null,
  createdAt: "2026-07-17T10:00:00.000Z",
};

function planRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "r-plan",
    planId: "p1",
    kind: "plan",
    status: "completed",
    iterationsDone: 0,
    exitReason: null,
    startedAt: "2026-07-17T10:00:00.000Z",
    endedAt: "2026-07-17T10:01:00.000Z",
    provider: "anthropic",
    model: "opus",
    promptTokens: 1000,
    completionTokens: 100,
    costUsd: 0.25,
    iterations: [],
    ...overrides,
  };
}

function loopRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "r-loop",
    kind: "loop",
    status: "completed",
    iterationsDone: 2,
    exitReason: null,
    startedAt: "2026-07-17T10:01:00.000Z",
    endedAt: "2026-07-17T10:03:00.000Z",
    provider: "anthropic",
    model: "sonnet",
    reviews: [
      {
        id: "rev-1",
        runId: "r-loop",
        decision: "approved",
        feedback: "criteria met",
        mergeCommit: "abcdef1234567",
        createdAt: "2026-07-17T10:04:00.000Z",
      },
    ],
    promptTokens: 500,
    completionTokens: 50,
    costUsd: 0.5,
    iterations: [
      {
        id: 1,
        runId: "r-loop",
        n: 1,
        status: "completed",
        summary: "wired the table",
        promptTokens: 300,
        completionTokens: 30,
        costUsd: 0.3,
        startedAt: "2026-07-17T10:01:00.000Z",
        endedAt: "2026-07-17T10:02:00.000Z",
      },
      {
        id: 2,
        runId: "r-loop",
        n: 2,
        status: "completed",
        summary: "added the totals row",
        promptTokens: 200,
        completionTokens: 20,
        costUsd: 0.2,
        startedAt: "2026-07-17T10:02:00.000Z",
        endedAt: "2026-07-17T10:03:00.000Z",
      },
    ],
    ...overrides,
  };
}

function evaluateRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "r-eval",
    kind: "evaluate",
    status: "completed",
    iterationsDone: 0,
    exitReason: "approve",
    startedAt: "2026-07-17T10:03:00.000Z",
    endedAt: "2026-07-17T10:04:00.000Z",
    provider: "anthropic",
    model: "opus",
    promptTokens: 2000,
    completionTokens: 200,
    costUsd: 0.25,
    iterations: [],
    ...overrides,
  };
}

/** The API returns runs newest-first; the table reverses them itself. */
function renderTable(runs: Run[], cardSummary: string | null = null) {
  return render(
    <RunsTable
      runs={runs}
      plans={[plan]}
      models={models}
      cardSummary={cardSummary}
      weakerIsolationRunIds={new Set()}
      onOpenTranscript={() => {}}
    />,
  );
}

afterEach(cleanup);

describe("runTotals", () => {
  it("sums a loop run from its iterations, falling back to the run row when it has none", () => {
    // The roll-up is only written at finishRun, so a live loop must read its
    // iterations or it would show as unmeasured while its numbers climb.
    expect(runTotals(loopRun({ promptTokens: null, completionTokens: null, costUsd: null }))).toEqual({
      promptTokens: 500,
      completionTokens: 50,
      costUsd: 0.5,
    });
    expect(runTotals(loopRun({ iterations: [] })).promptTokens).toBe(500);
  });

  it("reads plan and evaluate runs off the run row, reporting null rather than zero when unmeasured", () => {
    expect(runTotals(planRun())).toEqual({ promptTokens: 1000, completionTokens: 100, costUsd: 0.25 });
    expect(runTotals(planRun({ promptTokens: null, completionTokens: null, costUsd: null }))).toEqual({
      promptTokens: null,
      completionTokens: null,
      costUsd: null,
    });
  });
});

describe("RunsTable", () => {
  it("lists every run kind oldest first with its own tokens and cost, and totals them", () => {
    renderTable([evaluateRun(), loopRun(), planRun()]);

    const kinds = screen
      .getAllByRole("row")
      .map((row) => row.textContent ?? "")
      .filter((text) => /Planning|Loop|Evaluator/.test(text));
    expect(kinds).toHaveLength(3);
    expect(kinds[0]).toContain("Planning");
    expect(kinds[1]).toContain("Loop");
    expect(kinds[2]).toContain("Evaluator");

    // Planning and evaluator rows carry their own numbers, not just the loop.
    expect(screen.getByText("1,000")).toBeTruthy();
    expect(screen.getByText("2,000")).toBeTruthy();
    expect(screen.getAllByText("$0.2500")).toHaveLength(2);

    // 1000 + 500 + 2000 prompt, 100 + 50 + 200 completion, $0.25 + $0.50 + $0.25.
    expect(screen.getByText("3,500")).toBeTruthy();
    expect(screen.getByText("350")).toBeTruthy();
    expect(screen.getByText("$1.0000")).toBeTruthy();
    // 1m + 2m + 1m of actual run time.
    expect(screen.getByText("4m 0s")).toBeTruthy();
  });

  it("renders an unmeasured run as em dash rather than zero", () => {
    renderTable([planRun({ promptTokens: null, completionTokens: null, costUsd: null })]);

    // The row: iters (a plan run has none), prompt, completion, cost.
    // The totals row: prompt, completion, cost — an unmeasured run must not
    // total to a zero that would read as free.
    expect(screen.getAllByText("—")).toHaveLength(7);
  });

  it("keeps rows collapsed until asked, then shows the loop's iterations", () => {
    renderTable([loopRun()]);

    expect(screen.queryByText("wired the table")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Loop/ }));

    expect(screen.getByText("wired the table")).toBeTruthy();
    expect(screen.getByText("added the totals row")).toBeTruthy();
  });

  it("shows which checklist task each iteration worked on and how many are left", () => {
    const [first, second] = loopRun().iterations;
    renderTable([
      loopRun({
        status: "running",
        iterations: [
          { ...first, taskNumber: 1, taskCount: 2, taskText: "Wire the table", taskCompleted: 1 },
          { ...second, status: "running", taskNumber: 2, taskCount: 2, taskText: "Add totals", taskCompleted: null },
        ],
      }),
    ]);

    expect(screen.getByText("Task 1/2")).toBeTruthy();
    expect(screen.getByText("done")).toBeTruthy();
    expect(screen.getByText("Wire the table")).toBeTruthy();
    expect(screen.getByText("Task 2/2")).toBeTruthy();
    expect(screen.getByText("working")).toBeTruthy();
    expect(screen.getByText("Add totals")).toBeTruthy();
    expect(screen.getAllByText("1 left")).toHaveLength(2);
  });

  it("expands a planning run onto the plan it wrote", () => {
    renderTable([planRun()]);

    fireEvent.click(screen.getByRole("button", { name: /Planning/ }));

    expect(screen.getByText(/Plan v2/)).toBeTruthy();
    expect(screen.getByText("- the table totals every run")).toBeTruthy();
  });

  it("expands an evaluator run onto its verdict and the card summary", () => {
    renderTable([evaluateRun()], "shipped the runs table");

    fireEvent.click(screen.getByRole("button", { name: /Evaluator/ }));

    // The evaluator's own verdict is its exit reason.
    expect(screen.getAllByText("approve").length).toBeGreaterThan(0);
    expect(screen.getByText("shipped the runs table")).toBeTruthy();
  });

  it("shows the merge review under whichever run is carrying it", () => {
    // reviewService writes reviews.run_id against latestWorktreeRun, which is
    // kind-agnostic and in practice the loop run — not the evaluate run.
    renderTable([evaluateRun(), loopRun()]);

    fireEvent.click(screen.getByRole("button", { name: /Loop/ }));

    expect(screen.getByText("approved")).toBeTruthy();
    expect(screen.getByText("criteria met")).toBeTruthy();
    expect(screen.getByText("merged abcdef1")).toBeTruthy();
  });

  it("attaches the card summary to the latest evaluator run only", () => {
    const earlier = evaluateRun({ id: "r-eval-0", startedAt: "2026-07-17T09:00:00.000Z" });
    renderTable([evaluateRun(), earlier], "shipped the runs table");

    // Newest-first input, so `earlier` is the second row; open both.
    for (const button of screen.getAllByRole("button", { name: /Evaluator/ })) {
      fireEvent.click(button);
    }

    expect(screen.getAllByText("shipped the runs table")).toHaveLength(1);
  });

  it("opens a run that is executing right now without a click", () => {
    renderTable([loopRun({ status: "running", endedAt: null })]);

    expect(screen.getByText("wired the table")).toBeTruthy();
  });

  it("routes a transcript request with the run's provider, model, and reasoning level", () => {
    const opened: unknown[] = [];
    render(
      <RunsTable
        runs={[planRun()]}
        plans={[plan]}
        models={models}
        cardSummary={null}
        weakerIsolationRunIds={new Set()}
        onOpenTranscript={(target) => opened.push(target)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Planning/ }));
    fireEvent.click(screen.getByRole("button", { name: "view transcript" }));

    expect(opened).toEqual([
      {
        runId: "r-plan",
        iteration: 0,
        provider: "anthropic",
        model: "opus",
        reasoningLevel: "high",
      },
    ]);
  });

  it("flags a run that built its sandbox with weaker network isolation", () => {
    render(
      <RunsTable
        runs={[loopRun()]}
        plans={[plan]}
        models={models}
        cardSummary={null}
        weakerIsolationRunIds={new Set(["r-loop"])}
        onOpenTranscript={() => {}}
      />,
    );

    expect(screen.getByText("weaker isolation")).toBeTruthy();
  });
});
