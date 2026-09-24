# 30: A plan critic between planning and the loop

Decided 2026-09-24. Extends [17-task-scoping.md](17-task-scoping.md) and the
roles in [04-agent-pipeline.md](04-agent-pipeline.md); amends nothing else.

## The evidence

On the spec 25 epic a human read every plan before the loop started and sent
one of them back before any code was written. That single read saved a loop,
an evaluation and a re-plan. Every other piece on the epic went through one
revise cycle, and in each case the defect was one a second reader of the plan
could have named before the loop ran: a race the plan did not cover, a test
that could not run in the environment where it would run, an acceptance
criterion grepping for text the plan never produced. The evaluator caught all
of them, but only after a full loop and an evaluation had been paid for.

The human gate works, but it does not scale. Several pieces plan at once, and
a person reading every plan becomes the slowest stage in the pipeline. The
review is cheap relative to what it saves; what is missing is a reader who is
always there.

## Decisions

**1. A critic stage between planning and the loop.** After the planner
finishes, a read-only model session reviews the plan. It has its own
provider, model and reasoning level settings, so it can be a different model
from the planner. It reads the card, the scoping thread, the spec files the
card names and the three plan artifacts, and writes `.ralph/CRITIQUE.md` in
the evaluator's verdict format: `VERDICT: approve` or `VERDICT: revise` plus
feedback, parsed by the same parser the evaluator's verdict uses.

**2. Approve moves on; revise re-plans, at most twice.** An approve sends the
card where planning sends it today: Ready, or plan review when the card asks
for a human gate. A revise re-plans with the critic's feedback the way an
evaluator revise does. A plan may be sent back at most twice; the third
consecutive revise sends the card to plan review with the critic's notes
attached, so a person decides rather than the two models circling.

**3. On by default for breakdown cards, off for others.** A global setting
`planCriticMode` takes `breakdown` (the default: only cards created from a
breakdown are critiqued), `always` or `off`. A per-card override `planCritic`
takes inherit, on or off.

**4. Recorded as runs of a new kind `critique`.** Each critic session is a
run with the usual telemetry and its own transcript, `critique.jsonl`. Each
verdict appears in the card's activity as a `critique.decided` event.

**5. The critic writes nothing but its verdict file.** It runs with the
planner's tool set — writes confined to `.ralph/`, no bash — and the post-run
check rejects any change other than `.ralph/CRITIQUE.md`, as it does for the
evaluator.

**6. No new card status.** The card stays in `planning` while the critic
runs. The critique is part of producing a plan, not a state of its own.

## What this does not do

- Critique a plan the scoping session authored. The critic reviews the
  planner's output only.
- Inherit a killed critic attempt into its retry under spec 26. A critic
  retry starts clean.
