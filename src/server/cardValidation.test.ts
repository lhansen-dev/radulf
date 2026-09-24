import { describe, expect, it } from "vitest";
import { parseBreakdown } from "./cardValidation";

describe("parseBreakdown", () => {
  const pieces = (second: Record<string, unknown> = {}) => [
    { title: "a", description: "" },
    { title: "b", description: "", ...second },
  ];

  it("accepts the graph run mode and a piece's sibling dependencies (spec 28)", () => {
    const result = parseBreakdown({ runMode: "graph", pieces: pieces({ dependsOn: [0] }) });
    expect(result.runMode).toBe("graph");
    expect(result.pieces[1].dependsOn).toEqual([0]);
    expect(result.pieces[0]).not.toHaveProperty("dependsOn");
  });

  it("deduplicates and sorts dependsOn", () => {
    const result = parseBreakdown({
      pieces: [...pieces(), { title: "c", description: "", dependsOn: [1, 0, 1] }],
    });
    expect(result.pieces[2].dependsOn).toEqual([0, 1]);
  });

  it("defaults the run mode to ordered", () => {
    expect(parseBreakdown({ pieces: pieces() }).runMode).toBe("ordered");
  });

  it.each([
    [{ pieces: pieces({ dependsOn: [1] }) }, /itself/],
    [{ pieces: pieces({ dependsOn: [5] }) }, /unknown piece/],
    [{ pieces: pieces({ dependsOn: "0" }) }, /list of piece indexes/],
    [{ pieces: pieces({ dependsOn: [0.5] }) }, /list of piece indexes/],
    [{ runMode: "sideways", pieces: pieces() }, /ordered, parallel or graph/],
  ])("rejects an invalid breakdown body %#", (value, expected) => {
    expect(() => parseBreakdown(value)).toThrow(expected);
  });
});
