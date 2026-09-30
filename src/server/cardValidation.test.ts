import { describe, expect, it } from "vitest";
import { parseBreakdown, parseCreateCard, parseUpdateCard } from "./cardValidation";

describe("parseCreateCard plan critic override (spec 30)", () => {
  it("passes through an explicit planCritic flag", () => {
    expect(parseCreateCard({ repoId: "r", title: "t", planCritic: false })).toMatchObject({
      planCritic: false,
    });
  });

  it("keeps null as defer-to-settings and accepts a critic model", () => {
    expect(parseCreateCard({ repoId: "r", title: "t", planCritic: null, criticModel: "m" })).toMatchObject({
      planCritic: null,
      criticModel: "m",
    });
  });

  it("leaves planCritic undefined when omitted", () => {
    expect(parseCreateCard({ repoId: "r", title: "t" }).planCritic).toBeUndefined();
  });

  it("rejects a non-boolean planCritic", () => {
    expect(() => parseCreateCard({ repoId: "r", title: "t", planCritic: "yes" })).toThrow(
      /planCritic must be a boolean or null/,
    );
  });
});

describe("parseUpdateCard plan critic override (spec 30)", () => {
  it("stores null to clear the override", () => {
    expect(parseUpdateCard({ planCritic: null })).toEqual({ planCritic: null });
  });

  it("stores booleans as 1/0", () => {
    expect(parseUpdateCard({ planCritic: true })).toEqual({ planCritic: 1 });
    expect(parseUpdateCard({ planCritic: false })).toEqual({ planCritic: 0 });
  });

  it("accepts criticModel as an optional string", () => {
    expect(parseUpdateCard({ criticModel: "m" })).toEqual({ criticModel: "m" });
    expect(parseUpdateCard({ criticModel: null })).toEqual({ criticModel: null });
  });

  it("rejects a non-boolean planCritic", () => {
    expect(() => parseUpdateCard({ planCritic: "yes" })).toThrow();
  });
});

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

describe("jiraKey", () => {
  it("upper-cases a key on create", () => {
    expect(parseCreateCard({ repoId: "r", title: "t", jiraKey: "dev-12" }).jiraKey).toBe("DEV-12");
  });

  it("defaults to null when omitted", () => {
    expect(parseCreateCard({ repoId: "r", title: "t" }).jiraKey).toBeNull();
  });

  it.each([["not a key"], [12]])("rejects the create key %p", (jiraKey) => {
    expect(() => parseCreateCard({ repoId: "r", title: "t", jiraKey })).toThrow(/jiraKey must be/);
  });

  it("keeps null on update, so the key can be cleared", () => {
    expect(parseUpdateCard({ jiraKey: null })).toEqual({ jiraKey: null });
  });

  it("rejects a pasted link on update: a URL is not the key shape", () => {
    expect(() => parseUpdateCard({ jiraKey: "https://x/browse/DEV-1" })).toThrow(/jiraKey must be/);
  });

  it("carries a piece's key through a breakdown", () => {
    expect(parseBreakdown({ pieces: [{ title: "a", description: "", jiraKey: "DEV-5" }] }).pieces[0].jiraKey).toBe(
      "DEV-5",
    );
  });
});
