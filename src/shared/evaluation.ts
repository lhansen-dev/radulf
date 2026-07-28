export type Evaluation = { verdict: "approve" | "revise"; feedback: string };

/**
 * Parse `.ralph/EVALUATION.md`. The first line must be `VERDICT: approve` or
 * `VERDICT: revise`; whatever follows is the evaluator's note/feedback. A
 * `revise` verdict without feedback is malformed — the loop would have nothing
 * to act on. Returns null for anything malformed so the caller fails loudly.
 */
export function parseEvaluation(content: string): Evaluation | null {
  const lines = content.trim().split("\n");
  const match = /^VERDICT:\s*(approve|revise)\s*$/i.exec(lines[0] ?? "");
  if (!match) return null;
  const verdict = match[1].toLowerCase() as Evaluation["verdict"];
  const feedback = lines.slice(1).join("\n").trim();
  if (verdict === "revise" && !feedback) return null;
  return { verdict, feedback };
}
