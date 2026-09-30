import { describe, it, expect } from "vitest";
import { planningCandidates } from "./orchestrator";

describe("planningCandidates", () => {
  it("orders started cards chronologically even when board position disagrees", () => {
    const cardsByPosition = [
      { id: "newer", repoId: "repo-a", startedAt: "2026-07-16T12:00:00.000Z" },
      { id: "older", repoId: "repo-b", startedAt: "2026-07-16T10:00:00.000Z" },
    ];

    expect(planningCandidates(cardsByPosition, false)).toEqual([
      { cardId: "older", repoId: "repo-b" },
      { cardId: "newer", repoId: "repo-a" },
    ]);
  });

  it("includes the unstarted Todo queue, in board order, only while auto-mode is on", () => {
    const cardsByPosition = [
      { id: "first", repoId: "repo-a", startedAt: null },
      { id: "second", repoId: "repo-b", startedAt: null },
    ];

    expect(planningCandidates(cardsByPosition, false)).toEqual([]);
    expect(planningCandidates(cardsByPosition, true)).toEqual([
      { cardId: "first", repoId: "repo-a" },
      { cardId: "second", repoId: "repo-b" },
    ]);
  });
});
