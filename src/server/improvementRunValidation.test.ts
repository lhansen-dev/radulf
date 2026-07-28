import { describe, expect, it } from "vitest";
import { parseCreateImprovementRun } from "./improvementRunValidation";

const valid = { repoId: "repo-1", baseBranch: "main", budgetMinutes: 30 };

describe("parseCreateImprovementRun", () => {
  it("accepts a minimal valid body, defaulting optional fields to null", () => {
    expect(parseCreateImprovementRun(valid)).toEqual({
      repoId: "repo-1",
      baseBranch: "main",
      budgetMinutes: 30,
      focusPrompt: null,
      plannerModel: null,
      loopModel: null,
      evaluatorModel: null,
      plannerReasoning: null,
      loopReasoning: null,
      evaluatorReasoning: null,
      maxIterations: null,
      timeoutMinutes: null,
    });
  });

  it("passes through optional overrides", () => {
    const parsed = parseCreateImprovementRun({
      ...valid,
      focusPrompt: "Focus on test coverage",
      plannerModel: "opus",
      maxIterations: 5,
      timeoutMinutes: 60,
    });
    expect(parsed.focusPrompt).toBe("Focus on test coverage");
    expect(parsed.plannerModel).toBe("opus");
    expect(parsed.maxIterations).toBe(5);
    expect(parsed.timeoutMinutes).toBe(60);
  });

  it("rejects a missing repoId", () => {
    expect(() => parseCreateImprovementRun({ baseBranch: "main", budgetMinutes: 30 })).toThrow(
      "repoId is required",
    );
  });

  it("rejects a missing baseBranch", () => {
    expect(() => parseCreateImprovementRun({ repoId: "repo-1", budgetMinutes: 30 })).toThrow(
      "baseBranch is required",
    );
  });

  it("rejects a non-positive budgetMinutes", () => {
    expect(() => parseCreateImprovementRun({ ...valid, budgetMinutes: 0 })).toThrow(
      "budgetMinutes must be a positive integer",
    );
  });

  it("rejects a non-integer budgetMinutes", () => {
    expect(() => parseCreateImprovementRun({ ...valid, budgetMinutes: 1.5 })).toThrow(
      "budgetMinutes must be a positive integer",
    );
  });

  it("rejects unknown fields", () => {
    expect(() => parseCreateImprovementRun({ ...valid, bogus: "nope" })).toThrow(
      "unknown field: bogus",
    );
  });

  it("rejects a non-object body", () => {
    expect(() => parseCreateImprovementRun("nope")).toThrow("improvement run body must be an object");
  });
});
