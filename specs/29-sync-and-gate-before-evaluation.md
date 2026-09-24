# 29: Sync with base and gate before evaluation

Decided 2026-09-24. Extends [18-loop-failure-modes.md](18-loop-failure-modes.md)
item 7, the acceptance probe, and [27-repository-gate.md](27-repository-gate.md),
the repository gate. Respects [25-web-and-worker-processes.md](25-web-and-worker-processes.md)
decision 6, the per-repo delivery lease. Amends nothing else: the evaluator
remains the sole whole-card verifier and its verdict remains its own.

## The evidence

On the spec 25 epic, pieces 2 and 4 ran side by side from the same base. Both
touched one test file. The first to be approved merged cleanly; the second
reached the evaluator on a branch that no longer merged with the base, and the
conflict surfaced only at delivery, after the verdict. The merge was resolved
by hand and the run row was corrected by hand to match what had actually
landed. Nothing in the pipeline had looked at the base branch between the
loop's DONE and the evaluator's verdict.

On the same epic, five of six pieces took one revise cycle, and in each case
the evaluator was the first thing to run the whole-card checks. The loop's
checks are task-scoped by design, so a piece that passed every task check
could still fail the repository gate, and the only way to find out was to
spend an evaluation cycle on it: a planner turn, an evaluator turn, and a
second loop run to fix a failure a shell could have reported in a minute.

Spec 27 put the gate in front of the evaluator as evidence. It did not put it
in front of the loop, and it did not touch the base branch at all.

## Decisions

**1. Sync with base before evaluation.** When the loop signals DONE, the
orchestrator merges the base branch into the worktree before anything else
runs. A clean merge is committed by the orchestrator as a merge commit on the
run branch; the loop agent does not see it and does not need to. A conflict is
not a failure: the orchestrator appends a resolve-conflicts task to the
private plan naming the conflicted files, in the same way the acceptance
probe appends its repair task, and the loop continues. The loop agent edits
the files and signals ITERATION_DONE, and the orchestrator's bookkeeping
commit for that iteration completes the merge. The base branch is never
written by this step, and the sync takes the repository's delivery lease for
the duration of the read, so it never sees a base that an approval merge is
halfway through changing.

**2. The gate before DONE.** If the repository has a gate command, the gate
runs in the worktree after the sync, with the spec 27 runner and the spec 27
timeout. A non-zero exit appends a repair task to the private plan quoting the
tail of the output, and the loop continues. Evaluation starts only when the
gate passes with exit 0 or the repository has no gate. A gate that is killed
for time or cannot be run at all is recorded and handed to the evaluator as
before; it is a fact about the gate, not about the change, and does not send
the loop back.

**3. Bounded.** A loop run gets at most two sync-and-gate rounds. A round is a
sync that conflicts or a gate that fails and sends the loop back to work. If
the second round also ends in a conflict or a failing gate, the run fails and
the reason is written on the card, so a loop that cannot converge does not
consume iterations indefinitely.

**4. The evaluator reuses `.ralph/GATE.md`.** The loop's DONE path writes the
file spec 27 describes, with the same fields. A fresh cycle is a new loop run,
which clears the file at start, so a stale result never carries across cycles.
The evaluator's own gate step runs only when the file is missing, which is the
case for a repository whose gate was killed or could not run, and for any path
that reaches evaluation without a loop.

**5. Announced.** The sync emits `base.synced` with the merge commit, or
`base.conflict` with the conflicted files. The gate emits `gate.started` and
`gate.finished` with the exit code and duration, as spec 27 already does, and
`gate.repair` when a failing gate sends a task back to the loop. The card's
activity shows each round and what it cost.

## What this does not do

- Change anything under `src/server/harness/`. The harness runs the model; the
  sync and the gate are orchestrator work.
- Let the loop agent run state-changing git. The merge commit and the
  conflict-completing commit are both the orchestrator's.
- Change the approval merge path in `reviewService.ts`. Delivery to the base
  branch is unchanged; this decision only reads the base.
- Change the acceptance probe, which keeps its allowlist, its cap, and its
  role.
