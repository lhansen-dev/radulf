export type Finding = {
  severity: "critical" | "important" | "suggestion";
  file?: string;
  line?: number;
  issue: string;
};

export type Evaluation = { verdict: "approve" | "revise"; feedback: string; findings: Finding[] };

const SEVERITIES = new Set(["critical", "important", "suggestion"]);

function isFinding(v: unknown): v is Finding {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  return (
    typeof f.severity === "string" &&
    SEVERITIES.has(f.severity) &&
    typeof f.issue === "string" &&
    f.issue.trim().length > 0
  );
}

/**
 * Parse `.ralph/EVALUATION.md`. The first line must be `VERDICT: approve` or
 * `VERDICT: revise`; whatever follows is the evaluator's note/feedback. A
 * `revise` verdict without feedback is malformed — the loop would have nothing
 * to act on. Returns null for anything malformed so the caller fails loudly.
 *
 * An optional fenced ```findings block (JSON array of `Finding`) may follow
 * the feedback — additive detail for programmatic gating, not a replacement
 * for the prose. Absent entirely (old-format output, or a clean approve) ->
 * `findings: []`. Present but not valid JSON -> the whole evaluation is
 * malformed (null). Present and valid but containing an entry with a bad
 * shape -> that entry alone is dropped, not the whole evaluation.
 */
export function parseEvaluation(content: string): Evaluation | null {
  const lines = content.trim().split("\n");
  const match = /^VERDICT:\s*(approve|revise)\s*$/i.exec(lines[0] ?? "");
  if (!match) return null;
  const verdict = match[1].toLowerCase() as Evaluation["verdict"];
  const rest = lines.slice(1).join("\n").trim();

  const fenceMatch = /```findings\s*\n([\s\S]*?)\n?```/.exec(rest);
  let findings: Finding[] = [];
  let feedback = rest;
  if (fenceMatch) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fenceMatch[1]);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed)) return null;
    findings = parsed.filter(isFinding);
    feedback = (rest.slice(0, fenceMatch.index) + rest.slice(fenceMatch.index + fenceMatch[0].length)).trim();
  }

  if (verdict === "revise" && !feedback) return null;
  return { verdict, feedback, findings };
}
