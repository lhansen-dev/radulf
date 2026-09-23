# Design history

Radulf's `specs/` directory is a **dated decision log**, not documentation. Each
spec records what was decided, when, and why — including decisions that have
since been overturned by later specs. It is genuinely useful if you want to know
*why* something is the way it is, and actively misleading if you read it as a
description of how Radulf works today.

**If you want to know how Radulf works, read the guides instead** — start with
[How it works](HOW_IT_WORKS.md). The specs are kept honest about their own
history rather than rewritten, so nothing here is edited to match the present.

## Read this first

Several specs are superseded. The harness design in particular was decided three
times:

```
   09 multi-harness  ──▶  12 pi-harness  ──▶  13 single-pi-sdk-harness
   (a harness per         (pi added as a      (one harness for every
    provider)              fourth harness)     provider — what ships)
```

Reading 09 on its own will tell you that the loop harness follows the provider —
that Claude runs claude-code and oMLX runs opencode. That has not been true
since spec 13 consolidated everything onto pi in SDK mode. Likewise, spec 14
re-amended the permissions posture from "worktree plus prompt guardrails" to
kernel-enforced containment.

The current state of any decision is best read from the guides, or from the
"Locked decisions" list in `00-overview` — which carries its own amendment
history inline.

## The specs

| Spec | Subject | Status |
|------|---------|--------|
| [00 — Overview](../specs/00-overview.md) | The spec index, the locked decisions, and the glossary | Current, with inline amendments |
| [01 — Product](../specs/01-product.md) | Vision, the user, core flows, non-goals | Current |
| [02 — Architecture](../specs/02-architecture.md) | Process model, stack, the orchestrator, runner contracts | Mostly current; safety posture amended by 14 |
| [03 — Data model](../specs/03-data-model.md) | The SQLite schema and entity lifecycles | Current |
| [04 — Agent pipeline](../specs/04-agent-pipeline.md) | Planning, the Ralph loop, the evaluator gate, review and merge | Current |
| [05 — UI design](../specs/05-ui-design.md) | Board layout, card detail, diff review | Presentation superseded by 10 |
| [06 — Self-improvement](../specs/06-self-improvement.md) | Self-hosting mechanics, Improvement Runs, autonomy boundaries | Current — see also the [Improvement Runs guide](IMPROVEMENT_RUNS.md) |
| [07 — Definition of works](../specs/07-roadmap.md) | What "done" means, plus the post-v1 backlog | Planning document |
| [08 — Hosting and auth](../specs/08-hosting-auth.md) | Internet exposure and single-password auth | Current — see also the [Authentication guide](AUTHENTICATION.md) |
| [09 — Multi-harness runners](../specs/09-multi-harness.md) | A loop harness per provider | **Superseded by 13** |
| [10 — Mobile-first workspace](../specs/10-mobile-first-ui.md) | The attention-ordered Work feed and responsive layout | Current; amends 05 |
| [11 — Loop performance](../specs/11-loop-performance.md) | Loop latency, token and turn telemetry, lean harnesses, benchmarks | Current; amends 09, amended by 18 |
| [12 — Pi harness](../specs/12-pi-harness.md) | pi as a fourth harness, and the proxied-provider default | **Superseded by 13** |
| [13 — One harness: pi in SDK mode](../specs/13-single-pi-sdk-harness.md) | Consolidating every provider onto pi in SDK mode | Current — this is what ships |
| [13 — Implementation checklist](../specs/13-implementation-checklist.md) | The checklist that tracked the migration to 13 | Completed |
| [14 — Sandboxing](../specs/14-sandboxing.md) | Kernel-enforced containment and the threat model | Current; amended by 19. See also the [Sandboxing guide](SANDBOXING.md) |
| [15 — GitHub PR delivery](../specs/15-github-pr-delivery.md) | Delivering an approved diff as a pull request instead of a local merge | Current; amends decision 6 |
| [17 — Task scoping](../specs/17-task-scoping.md) | A repo-aware scoping thread on every card, closing the planner's questions loop | Current; extends 04, adds a fourth role to decision 3, replaces 10's planner chat. Fully built |
| [18 — Loop failure modes](../specs/18-loop-failure-modes.md) | What the loop knows when an iteration ends badly, and what it does with it | Current; amends 11 |
| [19: Radulf's own refs](../specs/19-shared-git-ref-noise.md) | Why a sibling card's branch is not tampering, and what the run-end integrity check still compares | Current; amends 14 |
| [20: More than one card at a time](../specs/20-concurrent-cards.md) | The per-repo concurrency cap, and telling the integrity check about the merges Radulf itself performs | Current; amends locked decision 5, completes 19 |
| [21: Registering a repository by URL](../specs/21-clone-on-register.md) | Cloning into Radulf's own repos dir when a URL is registered, so a server or container install needs no pre-mounted checkouts | Current; extends locked decision 1 |
| [22: Scheduling queue drains and improvement runs](../specs/22-scheduled-work.md) | Cron schedules for the two things that want to happen unattended, and what that does to 06's autonomy boundary | Current; amends 06's hard rule 2, delivers roadmap item 4 |
| [23: Logging a provider in from the app](../specs/23-provider-login-in-app.md) | Driving pi's typed login interaction from a route, so a server or container install needs no TUI over `docker exec` | Current; narrows the "OAuth belongs in the terminal" posture to "drive a typed interface, shell out otherwise" |
| [24: Epics](../specs/24-epics.md) | Breaking one ask into child tasks under a parent card, with a run mode the queue enforces, and Jira child issues as pieces | Current; extends 17, amends 20's scope note |

## Implementation plans

`docs/` also held two implementation plans — checklists with a finish line
rather than reference material — for spec 14's sandboxing work and for
Improvement Runs. Both were completed and removed from the tree; they remain in
git history if you want the phasing or the progress log that recorded the two
bugs the live Improvement Runs exposed.

What they built is documented in [Sandboxing](SANDBOXING.md) and
[Improvement Runs](IMPROVEMENT_RUNS.md).

## The locked decisions

A handful of decisions were made at the outset and are treated as fixed unless
explicitly revisited: the task domain (coding tasks against local Git repos),
the stack, a metered pipeline (one card at a time until you raise it, and
always one on a local model), in-app diff review, and — the
one that matters most — **merging always requires human approval**. No version
of Radulf merges on its own without an explicit opt-in design.

The full list, with each amendment dated, is in
[`00-overview`](../specs/00-overview.md#locked-decisions).
