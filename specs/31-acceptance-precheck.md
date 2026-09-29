# 31: Probe acceptance checks against the untouched worktree

Decided 2026-09-25. Extends [18-loop-failure-modes.md](18-loop-failure-modes.md) §7 and [30-plan-critic.md](30-plan-critic.md).

## The evidence

Spec 18 §7 put a check on the loop's DONE claim, and the sample says the check
is aimed at the expensive end of the pipeline. Across 24 runs and 118
iterations — $2.52 of the $52 those runs could have cost — the post-DONE probe
fired 8 times, in 8 different runs, and each time it spent that run's single
repair iteration. Every one of those was paid for after a whole loop, at the
point where a bad acceptance list is most expensive to correct, and every one
bought a repair pass rather than a better plan.

The question the loop cannot answer is the one that is free before it starts. A
check that already exits the way its criterion wants on a worktree nobody has
touched will exit that way whether the loop changes anything or nothing, so it
cannot evidence this card's work — and a plan whose acceptance list is built out
of such checks reaches DONE, an evaluation and an approval without having done
anything. Three criteria from that sample, three spellings of one rename check,
all written with the prose inverted, are the same fact from the other side:

- `grep -rq old_name src`, with prose reading "fails (no references remain)"
- `grep -rq 'old_name' src docs`, with prose reading "FAILS (exit 1, the old name
  is gone everywhere)"
- `grep -q new_name src/a.ts` succeeds and `grep -rq old_name src/` fails (no
  remaining references) — one criterion line, both directions at once

Read as bare commands, each of those exits 0 or non-zero for reasons that have
nothing to do with the card; read with the prose, the first two exit 0 *before*
the work and non-zero after it, which is a healthy new-behaviour check. So the
commands can be run before the loop, but "already exits the way the criterion
wants" and "exits the wrong way because the work is not done" are separable only
by an extractor that knows which way each criterion points. That is why this is
the same probe run earlier rather than a new one.

## Decisions

**1. Pre-check the plan's checks while the card is still in `planning`.** Once
the planner's artifacts validate and before the plan row is written,
`precheckAcceptance` runs the new-behaviour commands from `CRITERIA.md` against
the worktree as it stands — no iteration has run, so the worktree is the one the
card was handed. It reuses the post-DONE probe's extraction (`probeCommands`,
its `PROBE_ALLOWED` allowlist, its `SHELL_METACHARACTER` guard, and its
`EXPECT_FAILURE` reading of a span whose prose says `fails`) and its sandbox
(the run's own policy wrapper, sequential, 30 seconds per command), so a check
pre-checked here is exactly the check that will be probed after DONE and nothing
wider.

**2. The finding is an `acceptance.precheck` event.** One per planning run, on
the card's timeline, carrying the plan version, how many checks it ran, the
commands in each bucket — `alreadyPassing`, `failing`, `unprobed`, `skipped` —
and whether it is sending the plan back. `failing` is the expected, healthy
outcome on an untouched worktree and gets no action at all. A criteria document
with no runnable command emits nothing, so "nothing to say" stays
distinguishable from "checked, and nothing passed".

**3. One pre-check revise per plan, inside the critic's cap.** A first
already-passing finding sends the plan back to the planner with feedback naming
each command and the two exits for it — rewrite it so it fails now, or mark it a
regression — the way an evaluator or critic revise does, and the card never
leaves `planning`. At most one per plan, and it shares spec 30's
`MAX_CRITIC_REVISIONS = 2` with the plan critic: `consecutivePlanRevisions`
counts the critic's revise verdicts and the planning runs finished as
`precheck revise` since the last loop, and two between them escalate to plan
review. Past either bound the plan ships as written with the finding left in the
event; the loop and the evaluator still get their say.

**4. Already-passing commands are stored on the plan, reported after DONE, never
repaired.** They ride on the plan row (`plans.precheck_passing`, JSON, NULL when
nothing was probed, which is a different answer from "checked and none passed").
When the post-DONE probe later fails one of them, the failure is reported in the
`acceptance.probe` event's `alreadyPassing` field but does not spend the run's
single repair iteration — a repair pass spent making a tautology pass is a repair
pass thrown away, and it is the 8-of-24 cost above. Other failures repair as
before.

**5. `## Regression` is the marking, and it is the planner's, not an inference.**
`splitRegressionCriteria` cuts `CRITERIA.md` at a `## Regression` heading
(case-insensitive, whitespace-tolerant: a model types it) up to the next `## `
heading. Those commands are collected into the event as `skipped` and never run
by the pre-check — a check on behaviour an earlier card established passing now
is the point of it, and flagging every one would send back every card that
guards a neighbour. They are still probed after DONE like any other criterion. A
document without the heading is entirely new behaviour, which is every plan
written before this existed.

**6. A command that never ran takes no position.** Exit 127 (a check for a
binary this sandbox does not have), a command killed by the timeout, and a
sandbox wrap that could not be built are all reported as `unprobed` — neither
already-passing nor failing. `execCheck`'s `ran` flag carries that, and 127 is
listed with the non-numeric codes deliberately: the command goes through `exec`,
so a missing binary exits 127 with a *numeric* code and the non-numeric test
alone misses it. Reading unprobed as already-passing would send a plan back for a
revision it did not earn; reading it as failing would bury a real tautology under
our own plumbing.

**7. The pre-check cannot outrun a cancellation.** It adds seconds of awaiting to
a planning run, so the run re-checks `active()` — its own abort signal *and* that
the run row is still `running`, since the reaper or a cancel from the web process
can finalize the row out from under it — after the pre-check and again after the
plan commit, and no routing (`replan`, `critique`, `moveCard`) happens unless
`finishRun` returned true. The catch path returns first thing on an aborted
signal, and refuses to move a card whose row somebody else already closed. The
pre-check itself checks the signal before each command and never during one, and
marks its report `cancelled` so a partial pass is never read as a clean one.

## What this does not do

- Change what may be probed. `PROBE_ALLOWED` and `SHELL_METACHARACTER` are
  untouched; the pre-check runs the commands the post-DONE probe would run, so it
  widens no shell surface.
- Change the evaluator. It stays the sole whole-card verifier, and a zero exit
  still proves nothing — before the loop or after it. A plan with no
  already-passing checks is not a plan whose criteria hold.
- Add UI. The pre-check appears as `acceptance.precheck` in the card's events and
  nowhere else: no page, no panel, no card status, no setting.
- Judge the plan. `failing` is not a problem and nothing here says a criterion is
  met, the tasks are right, or the plan is sound. Spec 30's critic is the stage
  that reads a plan for quality; this runs its commands.
- Guess which checks are regressions. Only the planner's explicit `## Regression`
  heading is exempt — nothing classifies a criterion by looking at it.
- Pre-check a plan a scoping session authored (spec 17). Those rows keep
  `precheck_passing` NULL and behave exactly as plans written before this did.
- Send a plan back twice. One pre-check revise, shared cap, then a human.