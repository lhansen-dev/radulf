# 32: Revise the plan in place

Decided 2026-10-04. Amends [30-plan-critic.md](30-plan-critic.md) decision 2
and [31-acceptance-precheck.md](31-acceptance-precheck.md) decision 3.

## The evidence

Spec 30 re-plans a critic revise "the way an evaluator revise does", and spec
31 does the same for a pre-check revise. In code that meant the planner's
artifacts were cleared before the next run, so the planner received the
feedback and an empty `.ralph/`: never the plan the feedback was about. It
explored the repository again and wrote all three files from nothing.

The cost shows in the runs. Across the planning runs on the current planner
model (2026-09-24 to 2026-10-04), a plan written after a critic revise took 289
seconds on average, made 43.6 tool calls and wrote 29,400 output tokens. A
first plan took 274 seconds, made 42.8 tool calls and wrote 29,400 output
tokens. A revision cost exactly what the first plan cost. Transcripts show the
time goes to generation rather than tools. One 544-second revision spent 69
seconds on its first 14 turns of parallel reads. It then spent 266 seconds on
three long reasoning turns, and 109 seconds rewriting `CRITERIA.md` and a
10,600-token `PLAN.md` it had already written once.

The critic asked for revisions often enough for this to matter: 20 of 35
critiques returned `revise`, and 4 cards reached the two-revision cap. A card
that used both revisions waited roughly fifteen minutes in planning before its
first loop iteration. The planner also could not see what it had written, so
it could fix the named gap while losing something the critic had accepted.

## Decisions

**1. A plan-only revise seeds the previous plan.** When the feedback the
planner re-plans from is a critic revise or a pre-check revise, no code has
been written since that plan. The planning run writes the latest plan's
`PLAN.md`, `CRITERIA.md` and `PROMPT.md` back into `.ralph/` before the
session starts. The prompt says the files are the previous plan and asks the
planner to revise them in place, reading only the code it needs to settle the
feedback. An evaluator revise, a human rejection and a loop stop still clear
`.ralph/` and plan from the branch as before. Code has changed under those
plans, so the old checklist describes work that is partly done.

**2. Nothing else about a revision changes.** The revised artifacts pass the
same validation, the same pre-check and, when it is on, the same critic. The
two-revision cap is unchanged. `PLAN.md` and `CRITERIA.md` are still removed
before the plan commit, including on the questions path. Seeded copies never
reach branch history.

**3. An untouched seed is not a recovered plan.** Spec 26 decision 4 honours
complete artifacts left on disk when a watchdog kills the session. Seeded
artifacts are complete before the session begins, so a revision run that times
out or stalls is recovered only if at least one artifact differs from its seed.
Otherwise it fails like any other timeout, and the feedback is still pending
for its retry.

## Non-goals

- Changing the critic. It still reviews each version from the card, the
  thread, the specs and the plan. It is not told about its earlier verdicts.
- Seeding after an evaluator revise. The repair plan describes only the work
  left on top of the branch, and the old checklist would mislead it.
