# 20: More than one card at a time

Decided 2026-09-21. Amends locked decision 5 in
[00-overview.md](00-overview.md#locked-decisions), and completes the residual
[19-shared-git-ref-noise.md](19-shared-git-ref-noise.md) left open. No other
locked decision is reversed: merging still requires human approval, every DONE
still goes through the evaluator, and one card is still one agent working one
checklist.

Decision 5 reads: *"one ticket in the pipeline at a time. A single card runs
the planner, loop, or evaluator at any moment; the next card starts only once
that slot frees. Local models own the machine's unified memory, so the queue is
always serial."*

The reason given is **local models**. That reason is real, and it is the whole
of the justification. It does not apply to a subscription provider running in
the cloud, and the serialization it produces is expensive.

## The evidence

The board on the `radulf` repo at 01:44 on 2026-09-21, after a night of work:

| Card | Status |
|------|--------|
| Isolate the test suite from the repo-root data/ database | planning |
| Route agent bash through RTK | ready |
| Improve Radulf | ready |
| Prevent acceptance probes from executing mutating commands | ready |

Three cards waiting on one. They share no files: one edits
`src/server/acceptanceProbe.ts`, one `src/app/review/[id]/page.tsx`, one
`src/server/harness/`. The loop provider was `claude-sonnet-5` and the
evaluator `gpt-6-astra`, both remote, so nothing about the machine's memory was
the constraint. The queue was serial because the code says so.

Measured against the same night's runs, a loop iteration takes 1 to 5 minutes
and a card takes 4 to 8 of them, so each waiting card is waiting somewhere
between twenty minutes and an hour for a slot it does not need to share.

The single slot also produced a subtler cost. Because `approveInstallScripts`
resumes into evaluation without consulting the slot, the one path that already
ran two cards' agents at once was an accident rather than a design, and it was
that accident which exposed the ref-noise bug in spec 19.

## The decision

**1. A per-repo concurrency cap, defaulting to 1.**

`maxConcurrentCards` becomes a setting, bounded 1 to 8. The cap counts cards in
that repo currently holding a harness (`planning`, `looping`, `evaluating`).
Repos still never share a slot with each other, and `pump()` still fills ready
cards before planning new ones.

**2. The cap is forced to 1 whenever the loop provider is local.**

`omlx` owns the machine's unified memory, exactly as decision 5 says, so the
serial queue is preserved where its reason holds. The operator's setting is
ignored rather than rejected, because a provider can change under a saved
setting.

**3. Radulf records its own base-branch move instead of exempting it.**

Spec 19 deliberately left the base branch checked, because a human reviews a
run branch against its base and tampering with base is invisible to that
review. Concurrency makes a legitimate base move routine: approving card A's
merge while card B loops moves `refs/heads/<base>` under B's baseline.

So the merge tells the integrity layer what it did. Every live run holds a
registered baseline, and a successful merge patches the moved ref in each
baseline belonging to that repo. A base branch that moves for any *other*
reason is still a violation at run end. This is the general principle spec 19
applied by namespace, applied here by event: **Radulf ignores the ref changes
it made, and only those.**

**4. Managed refs include what pull-request delivery writes.**

`git push --set-upstream origin <ralph/branch>` updates
`refs/remotes/origin/ralph/<branch>` in the shared repo. Outside
`refs/heads/ralph/`, so spec 19's namespace did not cover it, and with
concurrency plus spec 15 delivery it lands mid-run for every other card. Any
`refs/remotes/<remote>/ralph/` ref is managed too.

**5. Install-script approval becomes one transaction.**

`approveInstallScripts` read the repo's approved list, appended, and wrote it
back. Two cards clearing their gates at the same moment lose one list. The
read-modify-write moves inside a transaction.

**6. The evaluator pumps the queue when it finishes.**

`EvaluationService` was the one stage constructed without a `pump`
dependency, so the slot an evaluation released was never refilled. A repo
could sit with cards in Ready and nothing running until some unrelated event
advanced the queue. Observed live on 2026-09-21: after an evaluation failed at
01:53, two ready cards on the same repo stayed parked with zero runs in
flight. At a cap of 1 that wastes one slot, and at a higher cap it would waste
several at once, so it is fixed here rather than filed.

## Why this is a smaller change than it sounds

Radulf already runs cards concurrently. `pump()` advances every repo
independently, so two repos have looped at the same time since the per-repo
slot replaced a global one. Everything a second concurrent run touches is
therefore already exercised: per-run worktrees and sandbox contexts, the WAL
database, the transcript writers, the process-group reaping.

The one piece that is genuinely process-wide was checked before writing this.
The sandbox's egress proxy filters against session-level config, so
`SandboxManager.updateConfig` mutates shared state. `wrapBashCommand` already
serializes that window behind a promise-chain mutex, and already fails loudly
if two concurrent calls carry genuinely different network policies. They never
do: policy is derived from global settings, with nothing per-card or per-role
in it. `docs/SANDBOXING.md` still described the old "strictly serial pipeline"
as the reason this is safe; that prose predates the mutex and is corrected
alongside this spec.

What is left is the per-repo cap itself, which is the counter this spec
changes.

## What this is not

This is **not** epics, task graphs, or scope-aware scheduling. Nothing here
splits one card's work across agents, and nothing coordinates two cards that
touch the same file. The planner still writes an ordered checklist for one
agent with continuous context, and two cards editing the same file will still
produce a merge conflict, handed back to the owning loop exactly as today
(`mergeBaseIntoWorktree`).

What this buys is the case that is already common and already safe:
**independent cards, queued behind each other for no reason.** Splitting a
single epic across parallel agents needs a write-scope per task and a
scheduler that refuses to co-schedule overlapping scopes. That is a larger
decision and belongs in its own spec.

## Accepted residuals

- **The circuit breaker stays global per provider.** N loops on one
  subscription share it, so one card's rate-limit storm opens the breaker for
  all of them. That is correct backpressure, not a bug: the provider is the
  shared resource.
- **Provider rate limits arrive N times faster.** The cap is the operator's
  dial for that, and the default of 1 changes nothing for anyone who does not
  raise it.
- **Machine load is the operator's problem.** Each loop's bash spawns real
  processes under the sandbox, and each worktree carries its own
  `node_modules`. Four concurrent `npm ci` runs will hurt long before four
  concurrent model calls do. The disk watchdog and ballast remain global and
  unchanged.
- **Review stays per card.** Nothing batches approvals, and the `reviewing`
  claim still serializes one card's merge against itself.
