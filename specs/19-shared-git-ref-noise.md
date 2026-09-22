# 19: Radulf's own refs are not tampering

Decided 2026-09-21. Amends [14-sandboxing.md](14-sandboxing.md), specifically
the run-end half of the repo integrity check (L3). No locked decision is
reversed, and nothing about containment changes: hooks and `.git/config` are
still hashed at run start, compared at run end, and compared again immediately
before merge. Only the **refs** portion of the run-end comparison is narrowed.

Spec 14 asked "what can an agent reach through the shared `.git`". This spec
asks what the answer costs once more than one card is in flight: **the check
fires on Radulf's own bookkeeping, and every false positive throws away a
finished run.**

## The evidence

Three runs on the stable deployment, 2026-09-20 into 2026-09-21, all on the
`radulf` repo, all destroyed by a ref Radulf itself wrote:

| Run | Kind | Ended | Exit reason |
|-----|------|-------|-------------|
| `xS4OILJN…` | loop, card `Improve Radulf` | 23:48:30 | `ref appeared: refs/heads/ralph/improve-1789947998164` |
| `4z15TVuI…` | evaluate, card `Isolate the test suite…` | 23:51:33 | `ref appeared: refs/heads/ralph/improve-1789947998164; ref moved: refs/heads/ralph/improve-radulf-jU7… (962b13d → ab816f1)` |
| `is32uEqu…` | evaluate, same card | 01:04:22 | `ref moved: refs/heads/ralph/route-agent-bash-through-rtk-… (9df3346 → 659e0c1)` |

Not one of those refs was written by an agent. `ralph/improve-1789947998164`
is the feature branch `createImprovementRun` cuts (`improvementRuns.ts`). The
other two are card run branches, moved by the orchestrator's own deterministic
commit at the end of a sibling card's iteration (`git.ts`).

The cost is not one run each. `xS4OILJN…` had already written its DONE, ticked
its task and committed; the check sits between that and `finishRun("completed")`,
so a card whose work was on disk went to Needs Attention, and its retry then
found an exhausted checklist and could never complete. The evaluator failures
cost a full evaluation pass each (five to six minutes of model time), and the
install-gate panel re-rendered unchanged after every one, so the operator
approved the same 24 packages three times with nothing to show for it.

The common shape: **a run's ref snapshot is repo-wide, but a run is only one
card.** Radulf runs an evaluator for card A alongside a loop for card B, and
every worktree shares one `.git`, so B's ordinary progress lands in A's
snapshot. The more the server is used as designed, the more often this fires.

Spec 14's own risk table anticipated an escalation here: *"clone-based layout
is the escalation if integrity violations ever fire."* They fired. But they
fired as false positives from Radulf's own writes, so the escalation would pay
a per-card clone to fix a problem the check invented. Narrow the check instead.

## The decision

The run-end refs comparison skips the whole `refs/heads/ralph/` namespace
rather than only `refs/heads/<this run's branch>`.

That namespace is exactly what Radulf writes on its own behalf, and nothing
else in the server writes a ref anywhere:

- `ralph/<slug>-<runId>`, a card's run branch (`git.ts`).
- `ralph/improve-<ts>`, an improvement run's feature branch
  (`improvementRuns.ts`).

Appeared, moved and deleted are all skipped inside it: a worktree cleanup
dropping a finished card's branch is as ordinary as a sibling iteration
committing.

Everything else is still compared, unchanged: base branches, `main`, tags,
remote-tracking refs, and of course hooks and `.git/config`. An agent that
rewrites `main` is still caught at run end. An agent that plants
`.git/hooks/post-merge` is still caught at run end **and** again pre-merge,
which spec 14 called the load-bearing check and which is untouched here.

## What this gives up

A ref planted or moved under `refs/heads/ralph/` is no longer reported. That is
the intended trade, and it is cheap: a ref is data, not execution. Nothing in
the pipeline merges, checks out or runs code from a `ralph/` branch it did not
create. `approveClaimedRun` merges `run.branch`, which was already exempt.
The controls that stop an agent from running `git` at all (the loop prompt
forbids state-changing git; L1 denies writes to `hooks/` and `config`) are
where that threat is actually handled.

## Known residual: the base branch

A merge moves the base branch, and `reviewService.approve` does not hold the
repo's pipeline slot. Approving card A's merge while card B is looping will
still fail B at its run-end check with `ref moved: refs/heads/beta (…)`.

That is deliberately left in place. The base branch is the one ref where
movement genuinely matters: a human reviews the diff of run branch against
base, so tampering with base is invisible to the review that gates the merge.
The fix, if it bites, is to serialize the merge behind the same pipeline slot
every other stage respects, not to widen this exemption.

## Also observed, not fixed here

Two failure modes surfaced by the same three runs, each its own change:

1. **A post-DONE failure is unrecoverable.** `runLoop` consumes `.ralph/DONE`
   and ticks the last task before the integrity check, and a fresh loop run
   deletes `.ralph/DONE` at startup. Any failure after DONE leaves a fully
   checked plan with no signal, and every retry dies at "plan checklist
   exhausted without a DONE signal" in milliseconds. The run-end checks belong
   before DONE is consumed, or the loop needs a "checklist complete, work
   banked" path into evaluation.
2. **The install-gate panel has no memory.** `card/[id]/page.tsx` renders it
   from `latestLoopRun.exitReason === "install-script gate"`, which never
   changes once the following runs are evaluations. Three successful approvals
   were indistinguishable from none.
