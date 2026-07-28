import { describe, expect, it } from "vitest";
import { groupBy } from "./queryGrouping";

describe("query grouping", () => {
  it("groups related rows without issuing per-parent lookups", () => {
    const rows = [
      { id: 1, runId: "a" },
      { id: 2, runId: "b" },
      { id: 3, runId: "a" },
    ];
    expect(groupBy(rows, (row) => row.runId).get("a")).toEqual([rows[0], rows[2]]);
  });
});
