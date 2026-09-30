import { describe, it, expect } from "vitest";
import { parseEvaluation } from "./evaluation";

describe("parseEvaluation", () => {
  it.each([
    ["an approve verdict with a note", "VERDICT: approve\n\nAll criteria pass.", "approve", "All criteria pass."],
    ["an approve verdict without a note", "VERDICT: approve", "approve", ""],
    ["a revise verdict with feedback", "VERDICT: revise\n\nsrc/foo.ts never handles null.", "revise", "src/foo.ts never handles null."],
    ["a verdict in any case with surrounding whitespace", "\n  verdict:  APPROVE  \nnote", "approve", "note"],
  ])("parses %s, defaulting findings to []", (_label, content, verdict, feedback) => {
    expect(parseEvaluation(content)).toEqual({ verdict, feedback, findings: [] });
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
