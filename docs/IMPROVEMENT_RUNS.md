# Improvement Runs

An **Improvement Run** is a time-boxed, self-driving loop: Radulf repeatedly
proposes *one* improvement to a repo, drives it through the normal pipeline with
auto-approve, and accumulates every approved change as a commit on a single
feature branch for you to review afterwards.

This is the **implementation reference** — what the feature does, what each knob
means, and where the code lives. For the *why* (autonomy boundaries, the
self-hosting trajectory), read [`specs/06-self-improvement.md`](../specs/06-self-improvement.md).

---

## The one-sentence model

**One branch, many cards, one budget.** The run cuts `ralph/improve-<ts>` off
your chosen base branch once, then every card it creates uses that branch as its
`baseBranch` — so each auto-approved merge folds back into the same branch, and
the next proposal sees everything landed so far.

```
Start run ──▶ cut ralph/improve-<ts> off <base>
                │
                ▼
        ┌───────────────────────────────────────────────┐
        │ deadline passed?  ──yes──▶ finish + alert     │
        │        │ no                                   │
        │        ▼                                      │
        │  propose ONE improvement                      │  repeat until
        │  (read-only planner, ephemeral worktree at    │  budget spent
        │   the feature-branch tip)                     │  or 3 failures
        │        ▼                                      │  in a row
        │  create card (todo · agent · autoApprove)     │
        │        ▼                                      │
        │  startCard ──▶ plan ▶ loop ▶ evaluate         │
        │        ▼                                      │
        │  approve ──▶ merge into ralph/improve-<ts>    │
        │  reject  ──▶ card left in Needs Attention     │
        └───────────────────────────────────────────────┘
```

The run **does not** use Auto Mode and never interleaves with your own Todo
queue — it calls `startCard` itself, one card at a time.

---

## Starting a run

**Details menu ▸ Start improvement run.**

| Field | Meaning |
|-------|---------|
| **Repository** | Which registered repo to improve. Only **one active run per repo** — starting a second returns a `400`. |
| **Base branch** | What the feature branch is cut from. Must already exist locally. |
| **Focus** _(optional)_ | Free text steering the proposer, e.g. _"improve test coverage"_. Injected as `{{FOCUS}}`. Blank ⇒ the proposer uses its own judgment. |
| **Time budget** | Wall-clock budget in minutes or hours (default 30 minutes). Becomes the run's `deadlineAt`. |
| **Planner / Loop / Evaluator model** _(Advanced)_ | Per-run model overrides, copied onto every card the run creates. Blank ⇒ the global Settings model. |
| **Per-task iteration cap** _(Advanced)_ | `maxIterations` for each spawned card. |
| **Per-task timeout** _(Advanced)_ | `timeoutMinutes` for each spawned card — **additionally capped at whatever budget remains**, so no single task can outlive the run. |

While a run is active it shows up in **Active now** on the Work feed: feature
branch, live countdown to the deadline, tasks landed, the in-flight card's
title, and a **Stop** button.

---

## What one cycle does

1. **Propose.** A read-only planner pass runs against an *ephemeral detached
   worktree* checked out at the feature branch's tip — so the proposer sees the
   accumulated work, not your checkout. The worktree is always torn down in a
   `finally`. Titles of everything already created this run are injected as
   `{{EXISTING_CARDS}}` so it doesn't repeat itself. Exactly one proposal is
   taken; extras are discarded.
2. **Create the card** — `status: todo`, `source: agent`, `autoApprove: 1`,
   `baseBranch: <feature branch>`, plus the run's model/iteration/timeout
   overrides. Emits `card.created`.
3. **Drive it** — `getOrchestrator().startCard(cardId)` directly (not the pump),
   then wait for the card to reach `done` / `needs_attention` / `abandoned`.
4. **Record the outcome** — `done` increments `tasksSucceeded` and resets the
   consecutive-failure counter; anything else increments it.

An approved card merges through the *same* path every other card uses — there is
no special merge code for Improvement Runs.

---

## Stopping, deadlines, and failure

**The timer is a soft gate.** It is checked only *between* tasks. A task already
in flight always finishes; nothing is ever killed mid-merge.

**Stop** sets `deadlineAt` to now, so the driver stops proposing new work at its
next check. The current task still finishes.

> **Stop is not instant.** The driver only looks at the clock between tasks, so
> a Stop pressed *during* a proposer pass waits for that pass to return — on a
> real repo that's several minutes (an observed pass took 8m 42s). A Stop
> pressed during a task waits for the whole card. The Work feed keeps showing the
> run as `running` until then; that's the soft gate, not a hang.

A run ends on any of these:

| Reason | Final status |
|--------|--------------|
| Budget spent (or **Stop** pressed) | `completed` / `stopped` |
| Proposer returned nothing 3 times in a row (15s backoff between tries) | `completed` / `stopped` |
| 3 **consecutive** task failures | `failed` |
| Repo unregistered mid-run, or the driver threw | `failed` |

A failed task is *left alone* in Needs Attention for you — the run does not
retry it, it just proposes the next thing. That is deliberate: a bad card should
cost one slot, not the whole budget.

When a run ends, `improvement.completed` fires and you get a browser
notification naming the feature branch and tasks landed (or an in-app banner if
notifications are off or unavailable).

---

## The feature branch is the deliverable

`ralph/improve-<ts>` is **never deleted automatically**. After a run:

```bash
git log --oneline <base>..ralph/improve-1753500000000   # what landed
git diff <base>...ralph/improve-1753500000000           # the whole accumulated diff
```

Review it like any other branch, then merge, cherry-pick, or delete it yourself.

---

## Persistence and resume

Run state lives in the `improvement_runs` table, so a server restart does not
silently kill a run. `resumeImprovementRuns()` runs from
[`src/server/boot.ts`](../src/server/boot.ts) in a process with the `worker`
role — once at boot *after* `getOrchestrator()`, so the orchestrator's
`recover()` has already flipped any orphaned card to `needs_attention`, and
again on every queue-pump tick so a run created by a web-only process (which
only inserts the row) is adopted within one pump interval. For each
still-`running` run it re-attaches to
`currentCardId`:

- already terminal ⇒ reconcile it (an interrupted card counts as a failure),
- still `todo`/`needs_attention` ⇒ re-issue `startCard` and wait,
- otherwise ⇒ just wait for it.

Drivers are guarded by a `globalThis`-backed `Set`, mirroring the orchestrator
singleton, so a run is driven at most once per process even across dev
hot-reloads.

---

## Customizing the proposer prompt

**Settings ▸ Prompts ▸ Self-improvement** edits the template
([`src/prompts/improve.md`](../src/prompts/improve.md)). Two placeholders are
substituted per pass:

| Placeholder | Replaced with |
|-------------|---------------|
| `{{EXISTING_CARDS}}` | Bullet list of titles already created this run |
| `{{FOCUS}}` | The run's Focus text, or a "use your own judgment" placeholder |

The prompt is what enforces *one* proposal, the JSON output shape
(`{title, description, rationale}`), and read-only behavior. Output that isn't a
valid JSON array is treated as "no proposal" — three of those in a row end the
run.

---

## API

| Method | Route | Notes |
|--------|-------|-------|
| `POST` | `/api/improvement-runs` | Creates + starts a run. `202` with the run row. `400` on validation failure or when a run is already active for that repo. |
| `GET` | `/api/improvement-runs` | `{ runs }` — active + recent, newest first, capped at 20. |
| `POST` | `/api/improvement-runs/:id/stop` | Soft-stop. `404` unknown id, `400` if the run isn't `running`. |

Create body (unknown fields are rejected):

```jsonc
{
  "repoId": "…",            // required
  "baseBranch": "main",     // required, must exist
  "budgetMinutes": 30,      // required, positive integer
  "focusPrompt": null,      // optional
  "plannerModel": null,     // optional \
  "loopModel": null,        // optional  } model overrides
  "evaluatorModel": null,   // optional /
  "maxIterations": null,    // optional, 1–1000
  "timeoutMinutes": null    // optional, 1–10080
}
```

Events on the SSE stream: `improvement.started` and `improvement.completed`
(payload: `runId`, `featureBranch`, `tasksSucceeded`, `status`, `reason`). Card
lifecycle events double as the banner's refresh trigger, since `currentCardId`
and `tasksSucceeded` only ever move in lockstep with a card's own events.

---

## Limits, at a glance

| Limit | Value | Where |
|-------|-------|-------|
| Active runs per repo | 1 | `createImprovementRun` |
| Proposals taken per cycle | 1 | `proposeOneImprovement` |
| Consecutive task failures before stopping | 3 | `recordCardOutcome` |
| Consecutive empty proposals before stopping | 3 (`EMPTY_PROPOSAL_LIMIT`) | `improvementRuns.ts` |
| Backoff after an empty proposal | 15s (`EMPTY_PROPOSAL_BACKOFF_MS`) | `improvementRuns.ts` |
| Proposer pass timeout | 15 min | `proposeOneImprovement` |
| Per-task timeout | `min(run.timeoutMinutes ?? default, remaining budget)` | driver loop |
| Runs returned by `GET` | 20 | `listImprovementRuns` |

---

## Where the code lives

| Piece | File |
|-------|------|
| Driver: create / loop / stop / resume | [`src/server/improvementRuns.ts`](../src/server/improvementRuns.ts) |
| Proposer pass (ephemeral worktree, read-only planner) | [`src/server/improvementProposer.ts`](../src/server/improvementProposer.ts) |
| Request validation | [`src/server/improvementRunValidation.ts`](../src/server/improvementRunValidation.ts) |
| Routes | [`src/app/api/improvement-runs/`](../src/app/api/improvement-runs/route.ts) |
| Setup dialog | [`src/app/ui/improvementRunDialog.tsx`](../src/app/ui/improvementRunDialog.tsx) |
| Work feed row, Stop button, completion banner | [`src/app/page.tsx`](../src/app/page.tsx) |
| Live data + completion alert | [`src/app/ui/useWorkData.ts`](../src/app/ui/useWorkData.ts) |
| Table + status enum | [`src/db/schema.ts`](../src/db/schema.ts) (`improvement_runs`, migration `0004_*`) |
| Proposer prompt | [`src/prompts/improve.md`](../src/prompts/improve.md) |

---

## Gotchas

- **A dirty working tree fails every merge — after the tokens are spent.**
  The merge refuses with `target checkout <path> has uncommitted changes — commit
  or stash them there, then press Retry merge`, and it only
  happens at the *end* of a card, so a full plan → loop → evaluate cycle is paid
  for and then lands in Needs Attention. Nothing validates this when the run is
  created, so an unclean checkout costs you the whole budget one card at a time.
  Commit or stash before starting a run. To rescue a card that hit this, clean
  the tree and `POST /api/cards/:id/retry-merge` — the work is intact.
- **Approved ≠ tidy.** The evaluator checks the acceptance criteria, not the
  blast radius. An observed run merged a stray 8,444-line `pnpm-lock.yaml`
  alongside its intended 88-line test change, because "the tests pass" was true
  either way. Read the branch diff, not just the card titles.
- **Runs cost real tokens.** Every cycle is a planner pass *plus* a full
  plan → loop → evaluate pipeline. A 4-hour budget can be a lot of cards. Start
  with 30 minutes against a repo you're happy to throw a branch away from.
- **Auto-approve ≠ unreviewed merge.** Cards still go through the evaluator; the
  human review step is what's skipped. The branch is your review surface.
- **Pull-request delivery does not apply to a run's cards.** A run's cards merge
  into its feature branch — that accumulation is the whole point, and the
  feature branch is local-only. Turning on **Open pull requests** workspace-wide
  leaves them alone. Delivering the finished run is still your call: it is one
  branch, and you push and open a pull request for it yourself.
- **Reasoning-level overrides are partially applied.** The run row carries
  `plannerReasoning` / `loopReasoning` / `evaluatorReasoning`, but `cards` has no
  per-card reasoning columns — only `plannerReasoning` reaches the proposer pass.
  Loop and evaluator reasoning stay on the global Settings value. The dialog
  therefore doesn't offer these fields; the API accepts them.
- **Pausing the in-flight card stalls the run.** The driver waits for a
  *terminal* status (`done` / `needs_attention` / `abandoned`), and `paused`
  isn't one — so a paused improvement card holds the run open past its deadline
  until you continue or abandon it. (Improvement cards never hit the plan-review
  gate: they're created with `reviewPlanBeforeImplementation = 0`.)
- **`stopped` vs `completed` is in-process.** The stop *intent* lives in memory,
  so a restart between Stop and the run actually ending labels it `completed`.
  Cosmetic only — the soft-stop itself is persisted as `deadlineAt`.
- **Improvement cards never touch Backlog.** They're created directly as `todo`
  with `source: "agent"`, so they don't queue behind your own work.
