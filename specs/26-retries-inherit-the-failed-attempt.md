# 26: Retries inherit the failed attempt

Decided 2026-09-23. Extends [18-loop-failure-modes.md](18-loop-failure-modes.md),
whose item 1 stopped the loop from throwing away a timed-out iteration's work,
to the two single-shot stages it left alone: the planner and the evaluator.
Amends nothing else. The retry verbs, the failed-status set in
`retryableFailedStep`, and the stage diagnosis from 18 item 4 are unchanged.

## The evidence

The evaluator for the first spec 25 piece timed out twice at the ten minute
default on 2026-09-23. Neither attempt was stuck. Each ran about forty tool
calls: build the worker bundle, run the new split check, run the unit tests,
run the whole suite, chase the failures. The second attempt did all of it
again from the top, because a retry today is byte-identical to the attempt it
retries. `clearEvaluationArtifact` deletes any partial verdict first, the
prompt is rendered from the same inputs, and the failed attempt's transcript
is read by nothing but the UI. The planner is the same, minus the transcript
size. Only a verdict flows between attempts: an evaluator's revise feedback or
a reviewer's rejection, into the next plan.

Two of the forty calls on the second attempt were the whole suite, which
cannot pass inside the sandbox for reasons unrelated to the change, and the
evaluator spent its budget diagnosing that instead of judging the diff.

## Decisions

**1. A retry sees its predecessor.** When a planner or evaluator attempt
starts and the card's most recent run is a failed, timed-out, or interrupted
attempt of the same stage, the prompt carries a previous-attempt section: the
exit reason and elapsed time, the model's last assistant text, and a bounded
digest of the commands the attempt ran with the tail of each output, built
from that run's transcript. The section is explicit that this comes from a
killed attempt: reuse what clearly passed, re-check what is inconclusive, do
not repeat the sequence. A fresh cycle, one that follows a new loop run,
carries nothing.

**2. The evaluator writes as it goes.** The evaluator keeps
`.ralph/EVALUATION-NOTES.md`, appending each check and its outcome. The file
survives a failed attempt, is forwarded verbatim, and is cleared only when a
fresh cycle starts. The planner's notes are its draft artifacts: whatever a
killed attempt left of `PLAN.md`, `CRITERIA.md`, and `PROMPT.md` is forwarded
as a draft before the retry clears `.ralph/`.

**3. The clock is in the prompt.** Both stages are told when they started,
what their budget is, and to have their result on disk by seventy percent of
it, checking with `date -u`. The model cannot see the watchdog otherwise, and
a hard timeout with nothing on disk is the worst outcome.

**4. A complete result on disk is honoured after a timeout.** The same rule
18 item 1 applied to the loop's signal file. An evaluator attempt killed with
a parseable verdict in `.ralph/EVALUATION.md` continues down the normal
verdict path; a planner attempt killed with all three artifacts present and a
parseable checklist continues down the normal plan path. Every post-run check
still applies, and an event records that the result was read after a timeout.

**5. Appended, not templated.** The new sections are appended to the rendered
prompt outside the templates, in the way the loop appends its signal
reminder, so an operator's customized template still gets them. The built-in
evaluator template adds the notes file to its list of writable outputs.

**6. Bounded.** The digest keeps a fixed number of commands and a fixed tail
of each output, and the whole section has a ceiling, for the reason 18 item 9
gives: prompt growth that nobody watches.

## What this does not do

- Change what counts as a retryable failure, or retry anything automatically.
- Resume a session. The retry is a new model session with better inputs.
- Run a repository's gate for the evaluator. That is a separate decision about
  a per-repository gate command and belongs to its own spec.
- Touch the loop, which has had its own version of this since 18.
