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

  it.each([
    [{ baseBranch: "main", budgetMinutes: 30 }, "repoId is required"],
    [{ repoId: "repo-1", budgetMinutes: 30 }, "baseBranch is required"],
    [{ ...valid, budgetMinutes: 0 }, "budgetMinutes must be an integer between 1 and 10080"],
    [{ ...valid, budgetMinutes: 1.5 }, "budgetMinutes must be an integer between 1 and 10080"],
    [{ ...valid, bogus: "nope" }, "unknown field: bogus"],
    ["nope", "improvement run body must be an object"],
  ])("rejects %j", (body, message) => {
    expect(() => parseCreateImprovementRun(body)).toThrow(message);
  });
});
