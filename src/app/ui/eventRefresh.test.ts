import { describe, expect, it } from "vitest";
import { refreshTargetsForEvent } from "./eventRefresh";

describe("refreshTargetsForEvent", () => {
  it("refreshes cards and improvement runs for orchestration telemetry", () => {
    expect(refreshTargetsForEvent("iteration.completed")).toEqual(["cards", "improvementRuns"]);
    expect(refreshTargetsForEvent("run.finished")).toEqual(["cards", "improvementRuns"]);
  });

  it("refreshes repository data only for repository changes", () => {
    expect(refreshTargetsForEvent("repo.created")).toEqual(["repos", "cards"]);
  });

  it("refreshes only improvement-run state for improvement-run lifecycle events", () => {
    expect(refreshTargetsForEvent("improvement.started")).toEqual(["improvementRuns"]);
    expect(refreshTargetsForEvent("improvement.completed")).toEqual(["improvementRuns"]);
  });
});
