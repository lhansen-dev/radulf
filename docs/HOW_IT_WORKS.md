# How it works

A card goes from a sentence you wrote to a merged branch by passing through
three agents. This page is the map.

## The pipeline

```
   you write        ┌──────────────── the pipeline ────────────────┐        you judge
                    │                                              │
  Backlog ──▶ Todo ─┼─▶ Plan ──▶ Loop ──▶ Evaluate ──▶ ...         ─┼─▶ In Review ──▶ Done
                    │             ▲          │                     │
                    │             └──────────┘                     │
                    │           revise: feedback becomes           │
                    │           the loop's next task               │
                    └──────────────────────────────────────────────┘
                                       │
                                       └──▶ Needs Attention (stuck, capped, or errored)
```

**1 · Plan.** The planner reads the card and the repo, then writes plan
artifacts into the worktree: a `PLAN.md`, a `PROMPT.md` for the loop to run, and
a `CRITERIA.md` holding the acceptance criteria. This is a single invocation,
and the card shows you the plan when it lands.

**2 · Loop.** The loop agent implements one task at a time inside a per-card
`git worktree`, running its targeted check each iteration. Every iteration is a
fresh context — the agent remembers nothing from the previous pass. The repo is
the memory: the plan, the progress notes, and the code already written are all
on disk. When the loop believes it is finished it writes a `DONE` signal, which
is trusted only as far as "start the evaluator" — it never sends a card to you
directly.

**3 · Evaluate.** The evaluator is the sole whole-card verifier, and it is
deliberately not the agent that did the work. It independently inspects the diff
and runs every acceptance criterion, then returns one of two verdicts:

- **revise** — concrete feedback, which becomes the loop's next assigned task.
  The card goes back to step 2. This can happen twice; a third would escalate
  the card to you instead of burning more budget.
- **approve** — the change is cleared and the card moves to In Review. On
  approve the evaluator also writes the card summary and refreshes any
  documentation the change made stale.

The evaluator may only write its own verdict file and documentation. If source
files or Git history change during evaluation the verdict is rejected outright,
so the judge provably cannot edit the implementation it just judged.

**4 · Review.** The diff waits for you in **In Review** with the transcript
alongside it. Approve merges the branch into the repo's default branch and moves
the card to Done. Reject takes your feedback, appends it to the plan, and sends
the card back for another pass.

## The three agent roles

| Role | Job |
|------|-----|
| **Planner** | Turns a card into a plan, a loop prompt, and acceptance criteria. |
| **Loop** | Implements one task at a time against the worktree, running its targeted check each iteration. |
| **Evaluator** | The sole whole-card verifier. Runs every criterion, inspects the diff, returns `approve` or `revise`, and on approve writes the summary and refreshes stale docs. |

Each role is configured independently — provider, model, and reasoning level —
on the Settings page. See [Providers and models](PROVIDERS.md).

> There is no separate summarizer agent. The evaluator writes the card summary
> as part of an approve verdict.

## Card states

| State | Meaning | Moved by |
|-------|---------|----------|
| **Backlog** | Written but not scheduled. Auto Mode never touches it. | You, on create |
| **Todo** | The ordered execution queue. Auto Mode pulls from here. | You |
| **In Progress** | Planning, looping, or evaluating — including revision cycles. | You start it; the orchestrator works it |
| **In Review** | An evaluator-cleared diff is waiting on your judgment. | Orchestrator |
| **Needs Attention** | Stalled, capped, errored, or merge-conflicted. | Orchestrator |
| **Done** | Approved and merged. | Orchestrator, on your approval |

The orchestrator moves cards on its own as it works them. The transitions that
need a human are: Backlog → Todo (you schedule it), Needs Attention → In
Progress (you fix and restart), and the review verdict itself.

## One card at a time

A single card occupies the planner, loop, or evaluator at any given moment, and
the next card starts only once that slot frees. There is no parallelism setting.
This is deliberate rather than a limitation waiting to be lifted: local models
want the whole machine's unified memory, so the queue is always serial. Cards
waiting for the slot show a "queued" sub-state.

While a card is looping you can **pause** it — the current iteration finishes
and then the card waits — and **continue** it later, optionally after changing
its per-card model overrides so that resumed iterations run differently.

## Where the work happens

```
data/                            gitignored; the sandbox denies it wholesale
  radulf.db                      the SQLite database
  pi-agent/auth.json             your provider credentials, held by pi
  transcripts/<run>/             normalized per-iteration transcripts
worktrees/<card>-<run>/          a git worktree on branch ralph/<card>-<run>
plans/<run>/                     the planner's writable output
```

Worktrees and plans sit *beside* `data/`, not inside it, and that is load-bearing
rather than cosmetic: the sandbox policy is a flat "deny `data/`" with no
carve-out, which only works if nothing an agent must write lives under it. Both
locations are overridable — `RADULF_WORKTREES_DIR` and `RADULF_PLANS_DIR`, with
`RADULF_DATA_DIR` for the rest.

Worktrees are created and removed by the orchestrator only, never by an agent.
Your registered checkout is written exactly once per card — the `--no-ff` merge
on approval — and that merge is unsandboxed, trusted server code that re-verifies
repo integrity immediately before it runs.

For what constrains the agents while they work, see [Sandboxing](SANDBOXING.md).
