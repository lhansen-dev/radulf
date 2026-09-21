# How it works

A card goes from a sentence you wrote to a merged branch by passing through
three agents. This page is the map.

## The pipeline

```
   you write        ┌──────────────── the pipeline ────────────────┐        you judge
                    │                                              │
  Backlog ──▶ Todo ─┼─▶ Plan ──▶ Loop ──▶ Evaluate ──▶ ...         ─┼─▶ In Review ──▶ Done
                    │    ▲                   │                     │
                    │    └───────────────────┘                     │
                    │    revise: re-plan with the                  │
                    │    evaluator's feedback                      │
                    └──────────────────────────────────────────────┘
                                       │
                                       └──▶ Needs Attention (stuck, capped, or errored)
```

**Scope it first, if the card is rough.** Every card carries a scoping thread
on its Task tab. An assistant that reads the card's repository, with no way to
change it, asks the questions a plan needs answered and can draft the scoped
task itself: a title and description for you to edit and apply. The planner
receives the whole thread, so decisions reached there shape the plan instead of
being retyped into the description. **Create and scope** in the New task dialog
takes a rough ask straight to that thread. Scoping is a role of its own in
Settings, separate from the planner, because you wait on every turn.

**1 · Plan.** The planner reads the card, its scoping thread, and the repo, then
writes plan artifacts into the worktree: a `PLAN.md`, a `PROMPT.md` for the loop
to run, and a `CRITERIA.md` holding the acceptance criteria. This is a single
invocation, and the card shows you the plan when it lands. A card the planner
finds too vague to plan gets questions instead of a guess: they land in the
scoping thread and the card goes to Needs Attention. Answer them there and
**Plan again**.

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

- **revise** — concrete feedback, which goes back to the planner. The card
  returns to step 1: the planner writes a new plan on top of the work already on
  the branch, and the loop and evaluator run again. This can happen twice; a
  third would escalate the card to you instead of burning more budget.
- **approve** — the change is cleared and the card moves to In Review. On
  approve the evaluator also writes the card summary and refreshes any
  documentation the change made stale.

The evaluator may only write its own verdict file and documentation. If source
files or Git history change during evaluation the verdict is rejected outright,
so the judge provably cannot edit the implementation it just judged.

**4 · Review.** The diff waits for you in **In Review** with the transcript
alongside it. Approve merges the branch into the repo's default branch and moves
the card to Done. Reject sends the card back to the planner with your feedback:
it writes a new plan on top of the work already on the branch, and the card
goes through the loop and the evaluator again.

**Where the approved diff goes.** By default, approving merges the branch into
the local base branch. Turn on **Open pull requests** — per card in the New Task
dialog, or workspace-wide from the Work page's `•••` menu — and approving
instead pushes the branch to `origin` and opens a pull request against the base,
leaving the local base branch untouched. It is one or the other, never both.

This needs the GitHub CLI (`gh`) installed and already authenticated: run
`gh auth login` in your terminal, the same way `make login` handles provider
auth. The option is unavailable, with the reason shown, when `gh` is missing,
`gh` is logged out, or the repo has no `origin`. Before pushing, Radulf merges
the base branch in (a conflict goes back to the loop exactly as it would for a
local merge) and strips `.ralph/`, so the pull request contains what you
reviewed and not the loop's own working notes. Radulf never merges the pull
request it opens.

**Skipping step 4.** Auto-approve makes an evaluator `approve` merge straight
through, with no human in the path. It can be granted two ways: per card, from
the New Task dialog, or workspace-wide, from the **Auto-approve** toggle in the
Work page's `•••` menu. Either one is enough; the card's own flag holds even
when the workspace toggle is off. The workspace toggle is read at the moment the
evaluator returns its verdict, so turning it on applies to work already in
flight — but not to cards already sitting in In Review, which have passed that
point and stay there waiting for you. Two things are never skipped: a
`critical` finding always forces human review, and a card that exhausts the
evaluator's revision limit is always escalated to you. Pre-merge repo-integrity
and merge-conflict checks run either way.

If auto-approve and pull-request delivery are both on, the pull request is opened
as a **draft** — nobody looked at the diff, and the draft says so. A pull request
Radulf opens as ready-for-review is one a human approved.

## The four agent roles

| Role | Job |
|------|-----|
| **Scoping** | Talks a rough card through with you, reading the repo read-only, and drafts the scoped task. Interactive; runs only when you ask. |
| **Planner** | Turns a card and its scoping thread into a plan, a loop prompt, and acceptance criteria. |
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
| **Needs Attention** | Stalled, capped, errored, merge-conflicted, or waiting on your answers to the planner's questions. | Orchestrator |
| **Done** | Approved and merged. | Orchestrator, on your approval |

The orchestrator moves cards on its own as it works them. The transitions that
need a human are: Backlog → Todo (you schedule it), Needs Attention → In
Progress (you fix and restart), and the review verdict itself.

Because Needs Attention waits on you, Radulf says so rather than waiting
quietly. A card that sits there longer than **Waiting-too-long alert** (Settings
→ Notifications, 15 minutes by default) raises a `card.attention_stale` event,
once per arrival. Set an **Alert webhook URL** there and the same thing is
POSTed as JSON, which is the only alerting that reaches you without a browser
tab open — ntfy, a Slack incoming hook, a Discord webhook and a handler of your
own all take it unchanged.

Two things Radulf will tell you there rather than let you discover by repeating
them:

- **A request the provider rejected.** An unsupported model, or a client too
  old to drive one, fails the same way every time, so the card carries the
  provider's own message and offers no retry for that step. Change the model
  under *Edit model overrides* and restart.
- **A stage that keeps failing the same way.** Three failures in a row for one
  role on one provider and model says something about the pairing rather than
  about luck, and the card says which role and which model. Retry stays
  available — it is a reading, not a block.

## How many cards run at once

By default, one. A single card occupies the planner, loop, or evaluator, and
the next card starts only once that slot frees. Cards waiting for a slot show a
"queued" sub-state. Different repos have always run at the same time; the cap
is per repo.

**Concurrent cards per repo** in Settings raises that, up to 8. Raise it when
the cards are independent, which is the common case: two cards editing the same
file will merge-conflict, and the loser is handed back to its own loop to
rebase. The setting is held at 1 while the loop provider is local, because a
local model wants the whole machine's unified memory, which is the actual
reason the queue was serial to begin with.

While a card is looping you can **pause** it — the current iteration finishes
and then the card waits — and **continue** it later, optionally after changing
its per-card model overrides so that resumed iterations run differently. A
paused run is recorded as paused, not completed, so stopping work yourself
never counts for or against the success rate in Activity.

## When the loop says it is done

DONE is the loop agent's own claim, and an evaluation is the most expensive
thing the pipeline does, so Radulf checks the cheap part first. Any shell
commands your acceptance criteria wrote in backticks are run in the worktree,
and a command that exits non-zero buys the loop one more iteration to fix what
it found before the evaluator is started.

Only failures count. A criterion can carry a judgment a shell cannot make
("returns at least 3 wrapper scripts"), so passing proves nothing and the
evaluator still decides. Only check-shaped commands run — `test`, `grep`,
`find`, `ls` and their kin — and anything else in backticks is left alone. The
repair pass happens at most once per run, because a criterion can be written so
that it can never pass.

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
