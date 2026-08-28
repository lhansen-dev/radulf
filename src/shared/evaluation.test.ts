import { describe, it, expect } from "vitest";
import { parseEvaluation } from "./evaluation";

describe("parseEvaluation", () => {
  it("parses an approve verdict with a note", () => {
    expect(parseEvaluation("VERDICT: approve\n\nAll criteria pass.")).toEqual({
      verdict: "approve",
      feedback: "All criteria pass.",
      findings: [],
    });
  });

  it("parses an approve verdict without a note", () => {
    expect(parseEvaluation("VERDICT: approve")).toEqual({
      verdict: "approve",
      feedback: "",
      findings: [],
    });
  });

  it("parses a revise verdict with feedback", () => {
    expect(parseEvaluation("VERDICT: revise\n\nsrc/foo.ts never handles null.")).toEqual({
      verdict: "revise",
      feedback: "src/foo.ts never handles null.",
      findings: [],
    });
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    expect(parseEvaluation("\n  verdict:  APPROVE  \nnote")).toEqual({
      verdict: "approve",
      feedback: "note",
      findings: [],
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

  describe("findings block", () => {
    it("parses a valid findings block and strips it from feedback", () => {
      const content = [
        "VERDICT: revise",
        "",
        "src/foo.ts never handles null.",
        "",
        "```findings",
        JSON.stringify([
          { severity: "critical", file: "src/foo.ts", line: 12, issue: "unhandled null deref" },
          { severity: "suggestion", issue: "consider extracting a helper" },
        ]),
        "```",
      ].join("\n");
      expect(parseEvaluation(content)).toEqual({
        verdict: "revise",
        feedback: "src/foo.ts never handles null.",
        findings: [
          { severity: "critical", file: "src/foo.ts", line: 12, issue: "unhandled null deref" },
          { severity: "suggestion", issue: "consider extracting a helper" },
        ],
      });
    });

    it("defaults to an empty array when no findings block is present (old-format compat)", () => {
      const result = parseEvaluation("VERDICT: approve\n\nAll criteria pass.");
      expect(result?.findings).toEqual([]);
    });

    it("fails the whole evaluation when the findings fence contains unparseable JSON", () => {
      const content = "VERDICT: approve\n\nnote\n\n```findings\nnot json\n```";
      expect(parseEvaluation(content)).toBeNull();
    });

    it("drops individual findings with an invalid severity, keeping valid ones", () => {
      const content = [
        "VERDICT: approve",
        "",
        "note",
        "",
        "```findings",
        JSON.stringify([
          { severity: "catastrophic", issue: "not a real severity" },
          { severity: "important", issue: "real finding" },
        ]),
        "```",
      ].join("\n");
      expect(parseEvaluation(content)).toEqual({
        verdict: "approve",
        feedback: "note",
        findings: [{ severity: "important", issue: "real finding" }],
      });
    });
  });
});
