/**
 * Recognizing a stage that is not going to work with the model it has.
 *
 * Spec 18 §4. Radulf retries a failed stage as often as the operator asks it
 * to, and each attempt is judged on its own: this evaluator run timed out, so
 * try again. Nothing ever looked at the sequence. On the card this was
 * measured against, five consecutive evaluator runs on `omlx` — one stuck and
 * three ten-minute timeouts — each burned around a million prompt tokens over
 * 34 to 99 turns. The sixth, on chatgpt/gpt-6-astra, returned a verdict in 12
 * turns and 36k tokens. That was a model-capability mismatch, and every fact
 * needed to name it was already in the `runs` table while it was happening.
 *
 * Deliberately not a lock. The diagnosis is a claim about a model's fit for a
 * role, which is exactly the kind of claim that is sometimes wrong, so it
 * informs the operator rather than blocking them.
 */

/** The run columns the diagnosis reads. */
export type DiagnosisRun = {
  kind: "plan" | "loop" | "evaluate";
  status: string;
  provider: string | null;
  model: string | null;
  startedAt: string;
};

/** How many attempts in a row, on one provider and model, before the pattern
 * is worth naming. Two is a coincidence; three is a configuration. */
export const MISCONFIGURED_STREAK = 3;

/** A run that ended badly on its own terms. A cancel is the operator's doing
 * and a restart is the process's, so neither says anything about the model. */
const FAILED = new Set(["failed", "timeout"]);

export type StageDiagnosis = {
  kind: DiagnosisRun["kind"];
  provider: string | null;
  model: string | null;
  attempts: number;
};

/**
 * Whether this card's most recent runs of one stage are a streak of failures
 * against a single provider and model, long enough to be about the pairing
 * rather than about luck.
 *
 * Walks back from the newest run of that kind and stops at the first run that
 * completed, was paused or cancelled, or used a different provider or model —
 * so switching models and failing again starts the count over, which is the
 * behaviour that makes the diagnosis mean anything.
 */
export function misconfiguredStage(
  runRows: DiagnosisRun[],
  kind: DiagnosisRun["kind"],
): StageDiagnosis | null {
  const ofKind = runRows
    .filter((run) => run.kind === kind)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const newest = ofKind[0];
  if (!newest || !FAILED.has(newest.status)) return null;

  let attempts = 0;
  for (const run of ofKind) {
    if (!FAILED.has(run.status)) break;
    if (run.provider !== newest.provider || run.model !== newest.model) break;
    attempts += 1;
  }
  if (attempts < MISCONFIGURED_STREAK) return null;
  return { kind, provider: newest.provider, model: newest.model, attempts };
}

/** The sentence the card detail page shows and the event payload carries. */
export function diagnosisMessage(d: StageDiagnosis): string {
  const role = d.kind === "plan" ? "planner" : d.kind === "loop" ? "loop" : "evaluator";
  const model = [d.provider, d.model].filter(Boolean).join("/") || "the configured model";
  return `The ${role} has failed ${d.attempts} times in a row on ${model}. A different model for this role is the next thing to try.`;
}
