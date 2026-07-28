import { describe, it, expect } from "vitest";
import { parseEvaluation } from "./evaluation";

describe("parseEvaluation", () => {
  it("parses an approve verdict with a note", () => {
    expect(parseEvaluation("VERDICT: approve\n\nAll criteria pass.")).toEqual({
      verdict: "approve",
      feedback: "All criteria pass.",
    });
  });

  it("parses an approve verdict without a note", () => {
    expect(parseEvaluation("VERDICT: approve")).toEqual({ verdict: "approve", feedback: "" });
  });

  it("parses a revise verdict with feedback", () => {
    expect(parseEvaluation("VERDICT: revise\n\nsrc/foo.ts never handles null.")).toEqual({
      verdict: "revise",
      feedback: "src/foo.ts never handles null.",
    });
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    expect(parseEvaluation("\n  verdict:  APPROVE  \nnote")).toEqual({
      verdict: "approve",
      feedback: "note",
    });
  });

  it("rejects a revise verdict without feedback — nothing to act on", () => {
    expect(parseEvaluation("VERDICT: revise\n\n  ")).toBeNull();
  });

  it("rejects a missing or malformed verdict line", () => {
    expect(parseEvaluation("")).toBeNull();
    expect(parseEvaluation("Looks good to me!")).toBeNull();
    expect(parseEvaluation("VERDICT: maybe\nfeedback")).toBeNull();
    expect(parseEvaluation("The verdict is:\nVERDICT: approve")).toBeNull();
  });
});
