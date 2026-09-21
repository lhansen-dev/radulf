# Architecture

This is the contributor's map: where each part of the pipeline lives in the
tree, and what owns what. [How it works](HOW_IT_WORKS.md) covers the same
pipeline for someone using Radulf rather than changing it.

> **This document describes the code as it stands.** [`specs/`](DESIGN_HISTORY.md)
> is a dated decision log, and parts of it have been overturned — spec 02's
> architecture predates the single-harness decision (13) and the sandboxing work
> (14). When the two disagree, the code and this page are current.

## The shape of it

One Next.js app. The server half runs in-process: there are no workers, no
queue, and no subprocesses for agent work — the pi SDK is a library call.

```
  Next.js route handlers          Orchestrator             pi SDK session
  (src/app/api/**/route.ts)  ──▶  (src/server/       ──▶   (src/server/
                                   orchestrator.ts)         harness/pi.ts)
        │                              │                        │
        │                              ▼                        ▼
        │                          SQLite                    agent bash
        │                        (src/db/)                  inside srt
        ▼                              │                   (src/server/
   SSE to the board  ◀───── events bus ┘                     sandbox/)
   (api/events/stream)   (src/server/events.ts)
```

Boot is `src/instrumentation.ts`: it ensures the auth secret, runs the sandbox
preflight (once, cached), constructs the orchestrator — whose `recover()` flips
any run orphaned by a restart into Needs Attention — and only then reattaches
improvement-run drivers.

## The orchestrator

`src/server/orchestrator.ts` is the single scheduler. Everything else in the
pipeline is a service it owns.

`pump()` fills a repo's free pipeline slots. `pipelineLoad()` counts that
repo's cards currently `planning`, `looping` or `evaluating`, and
`concurrencyLimit()` is the `maxConcurrentCards` setting, held at 1 while the
loop provider is local (spec 20). A `ready` card loops before any fresh `todo`
card is planned — in-flight work finishes ahead of new work. Backlog is never
queried.

State transitions go through `moveCard(cardId, from, to, reason)`, which is
compare-and-swap on the current status: it returns false if the card moved
underneath you. That is the concurrency discipline in this codebase — there are
no locks, and a stale card snapshot is expected. `finishRun` is the same idea
for runs, and its boolean return is what lets the disk watchdog and the abort
guard agree on who finalized a run.

Card statuses are `CARD_STATUSES` in `src/db/schema.ts` — thirteen of them, and
the mapping to the five board columns is in the comment above the list.
`planning`, `ready`, `looping`, and `evaluating` all render as In Progress;
`reviewing` renders as nothing at all, because it is a short-lived atomic claim
on a review decision rather than a state a card rests in.

## The three roles

Each role is a service with one entry point, and each constructs its own pi
session. The role is what decides the tool set — see the capability split below.

| Role | Module | Entry point | Timeout |
|---|---|---|---|
| Planner | `src/server/planningService.ts` | `runPlanning(cardId)` | `plannerTimeoutMinutes` setting, 30 min default |
| Loop | `src/server/orchestrator.ts` | `runLoop(cardId)` (private) | per-card, default 60 min |
| Evaluator | `src/server/evaluationService.ts` | `runEvaluator(cardId)` | `evaluatorTimeoutMinutes` setting, 10 min default |

The loop is not a separate service — it is the orchestrator's own method,
because it is the thing the pipeline slots exist to meter.

`src/server/reviewService.ts` is the fourth service but not an agent role: it
owns `approve`, `retryMerge`, and `abandon` — the human decisions.

### What one loop iteration does

`runLoop` is long because the iteration is where all the invariants land. In
order: check remaining budget → read the plan and take the first unchecked task
(`firstUnchecked` in `checklist.ts`; an exhausted checklist with no DONE signal
ends the run) → build the prompt (`buildLoopPrompt` in `bookkeeping.ts`) → run
one harness invocation → consume the iteration's signal files.

Progress is measured, not claimed. `buildProgressState` before and after the
iteration is compared; three consecutive iterations that change nothing exit as
`stalled`. The progress state hashes uncommitted content, not just the list of
dirty paths, so repeated edits to an already-modified file still count. An
`ITERATION_DONE` without a work product is a *phantom completion* — the
checklist is not advanced and the stall counter still sees it. Uncommitted
changes already in the worktree when the iteration started count as work
product: only loop agents leave a worktree dirty (planner, evaluator and
bookkeeping all commit), so that is work from a failed iteration or an earlier
run that the still-unchecked task gets credit for.

On a DONE signal the run-end ordering matters and is deliberate: reap the
process group first (a surviving process could plant hooks after a check that
already passed), then verify parent-repo integrity, then force the install-script
gate, and only then hand to the evaluator.

A DONE signal is accepted only when the iteration was assigned the final
unchecked task. Earlier signals are removed; normal iteration bookkeeping
still credits completed task work and the loop continues with the next task.

## The harness boundary

`src/server/harness/` is the only place that knows about pi.

- `index.ts` — `runHarness(opts)` drives one session and normalizes its events
  into a JSONL transcript. Watchdogs race the prompt: the iteration timeout,
  the stall watchdog (`stallTimeoutSeconds`, universal by default so a new call
  site gets it without opting in), the stuck detector (the same tool call four
  times in a row), the reply-size guard (`MAX_REPLY_CHARS`, 1 MiB of streamed
  text, thinking, and tool-call arguments in one assistant reply — a corrupt
  stream, aborted before it can overflow the context window), and an external
  `AbortSignal`. All of them call `session.abort()`; `dispose()` in the
  `finally` releases the session regardless.
- `pi.ts` — session construction, provider mapping, and event normalization
  (`piNormalize`). `toolsForRole` and `pathRootsForRole` are the capability
  split: the planner gets `web_search` and no `bash`; the loop and evaluator get
  `bash` and no `web_search`. Neither side holds both halves of an exfiltration
  chain — see [Sandboxing](SANDBOXING.md#role-capability-split).
- `guardedTools.ts` — filesystem tools with path enforcement.
- `webSearch.ts` — the planner's search tool, rate- and length-limited.
- `mock.ts` — the scripted `mock` provider (`RADULF_MOCK_LLM=1`): canned model
  decisions, real tool execution. See
  [Providers](PROVIDERS.md#testing-without-a-model-the-mock-provider).

Token and cost accounting is `foldTranscriptEvent` folding into
`TranscriptTotals`, which is what the analytics page and the benchmark runner
both read.

## Containment

`src/server/sandbox/` — [Sandboxing](SANDBOXING.md) is the full treatment; the
file map is:

| File | Owns |
|---|---|
| `srt.ts` | Policy construction (L1), `sandboxPreflight()`, `initializeSandboxRuntimeOnce()`, `dropRootsThatWouldReopen` |
| `context.ts` | The per-run factory: private tmpdir, cache root, agent env, bash command preamble |
| `pathGuard.ts` | Layer 2 — `guardPath`, the root-only check every file-tool path argument passes through |
| `diskWatchdog.ts` | The per-run and free-space bounds, and the ballast file |
| `cgroup.ts` | Linux cgroup setup and teardown |

One `RunSandboxContext` is created per run by the entry point and cleaned up in
its `finally`; it threads into the pi session's bash spawn hook via
`RunHarnessOpts.runContext`.

## Git

`src/server/git.ts` wraps every git call. Each run gets a worktree on its own
branch (`createWorktree`), so your checkout is untouched until a merge.

`mergeBranch` is the one write to the user's repo. It checks out the base
branch, refuses a dirty tree, merges `--no-ff --no-commit` so `.ralph/` can be
dropped before committing, and restores your original branch on every path
including failure. It distinguishes a content conflict (`conflict: true`,
recoverable — the card goes back to the loop via `mergeBaseIntoWorktree`) from
an unrecoverable failure.

## Persistence

`src/db/schema.ts`, Drizzle over SQLite, created on first run with no migration
step. Nine tables: `repos`, `cards`, `plans`, `runs`, `iterations`, `reviews`,
`events`, `improvementRuns`, `settings`.

Transcripts are **not** in the database — they are JSONL files on disk, read in
chunks by `src/server/transcript.ts` (`TRANSCRIPT_CHUNK_BYTES`, 512 KB). A long
run's transcript is far too big for a row.

Settings is a single-row table, read synchronously via `getSettings()`. Provider
credentials live there and flow into the session at runtime; the agent's shell
runs with a scrubbed env (`agentEnv`) so it cannot read them.

Token/cost telemetry lands on both `runs` and `iterations`, at two different
grains. `iterations` is per loop iteration only — it never existed for plan or
evaluate, which don't iterate. `runs` carries a role-level roll-up for every
kind: a loop run's is the sum of its iterations, written when the run finishes;
a plan or evaluate run writes its single harness invocation's numbers directly
(`planningService.ts`, `evaluationService.ts`). `analytics.ts` sources cost and
token totals from `runs`, which is what makes planner and evaluator spend
visible at all — summing `iterations` alone only ever covered the loop.

The DB runs in WAL mode (`src/db/index.ts`), so backing it up is never a raw
`cp` of `radulf.db` while the server is running — that can miss uncommitted
WAL frames and copy a torn, inconsistent file. Use `make db-backup`, which
shells out to the `sqlite3` CLI's `VACUUM INTO` to write a consistent,
timestamped snapshot instead.

## Events and the UI

`src/server/events.ts` is an `EventEmitter` on a global, so a Next.js hot reload
does not orphan subscribers. `emitEvent` writes to the `events` table *and*
publishes to the bus.

`src/app/api/events/stream/route.ts` is the SSE feed the board subscribes to,
with a 25s heartbeat. This is why the board updates without polling.

## Improvement Runs

`src/server/improvementRuns.ts` sits *above* the orchestrator rather than inside
it: `driveRun(runId)` is a loop that proposes one card
(`improvementProposer.ts`), creates it, and waits for it to reach a terminal
status (`awaitCardTerminal`) before proposing the next. It uses the same single
pipeline slot as everything else.

It re-reads the run row after each proposer pass rather than trusting its
snapshot — the proposer takes minutes, and a Stop landing in that window only
moves `deadlineAt` in the database. See
[Improvement Runs](IMPROVEMENT_RUNS.md).

## API surface

`src/app/api/**/route.ts`, thin by design — a route handler validates, calls a
service, and returns. Card actions live under `api/cards/[id]/`: `move` and
`diff` have their own routes; the single-verb transitions (`pause`, `resume`,
`restart`, `reset`, `abandon`, `approve-plan`, `approve-install`,
`retry-merge`, `retry-failed-step`) share the `[action]` route's table.

## Where to start reading

- Changing the pipeline's shape → `orchestrator.ts`, `pump()` then `runLoop()`.
- Changing what an agent can do → `harness/pi.ts`, `toolsForRole`.
- Changing containment → `sandbox/srt.ts`, and read
  [Sandboxing](SANDBOXING.md) first.
- Adding a provider → `providers.ts` and `harness/pi.ts`'s `PI_PROVIDER`.

Conventions, dev setup, and how to propose a change are in
[Contributing](../CONTRIBUTING.md).
