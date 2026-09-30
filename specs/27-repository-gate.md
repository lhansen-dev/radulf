# 27: A repository gate, run outside the model

Decided 2026-09-23. Extends [18-loop-failure-modes.md](18-loop-failure-modes.md)
item 7, the acceptance probe, and [26-retries-inherit-the-failed-attempt.md](26-retries-inherit-the-failed-attempt.md),
which named this as the decision it left out. Amends nothing else: the
evaluator remains the sole whole-card verifier and its verdict remains its own.

## The evidence

The evaluator for the first spec 25 piece spent most of two ten minute
attempts waiting on a production build and a test suite it had started
itself, and reached no verdict either time. On this repository the whole-card
gate is `make check`: a build, the suite, lint, and typecheck. The model was
paying, in tokens and in its budget, to sit next to a process that needed no
model at all.

The acceptance probe from spec 18 already runs criteria commands
mechanically after a loop, but by design only read-only ones, with a thirty
second cap, and its result goes into a repair task for the loop, never to the
evaluator.

## Decisions

**1. A repository may declare one gate command.** It is stored on the
repository row, edited from the repositories settings and the repository API,
and empty means no gate. It is a property of the repository, not of a card or
a plan, because it is the repository's own definition of done and a model
should neither invent it nor be able to skip it.

**2. The orchestrator runs it, before the evaluator, in the evaluator's
sandbox.** At the start of an evaluation cycle, before the harness is built,
the gate runs in the worktree under the run's sandbox context, with its own
timeout setting. The evaluator holds bash and runs there; the gate runs where
the evaluator's bash would, and never on the host directly.

**3. The result is a file and a prompt section.** `.ralph/GATE.md` records the
command, the exit code or the kill, the duration, when it ran, and a bounded
tail of the output. The evaluator prompt carries the same text and an
instruction not to run the gate again. Like every `.ralph/` file it is
committed with the verdict and stripped at merge.

**4. Once per cycle.** A retry of the evaluator reuses the file the cycle's
first attempt left. A new loop run starts a fresh cycle and the gate runs
again. This is the same rule spec 26 applies to the evaluator's running notes.

**5. Evidence, not a verdict.** A failing gate does not send the card back by
itself. The evaluator reads the output, writes the verdict and the feedback,
and a gate that was killed for time is a fact about the gate, not about the
change. The stage keeps one judge.

**6. Announced.** Each gate run emits a start and a finish event with the exit
code and duration, so the card's activity shows what the orchestrator did on
the evaluator's behalf and how long it took.

## What this does not do

- Run the gate for the loop's tasks. The loop's checks stay task-scoped, as
  the planner prompt already requires.
- Decide the verdict from the exit code. See decision 5.
- Allow more than one gate, or a gate per card. One command per repository is
  the whole surface.
- Change the acceptance probe, which keeps its allowlist and its role.
