# Architecture

This is the contributor's map: where each part of the pipeline lives in the
tree, and what owns what. [How it works](HOW_IT_WORKS.md) covers the same
pipeline for someone using Radulf rather than changing it.

> **This document describes the code as it stands.** [`specs/`](DESIGN_HISTORY.md)
> is a dated decision log, and parts of it have been overturned — spec 02's
> architecture predates the single-harness decision (13) and the sandboxing work
> (14). When the two disagree, the code and this page are current.

## The shape of it

One codebase and one image, run as two roles. `web` serves the UI and API,
authenticates, writes operator intent (card moves, approvals, cancel/pause),
tails the events table and watches running transcripts; it never runs an
agent, never touches a worktree, and has no sandbox. `worker` claims runs and
review deliveries, runs pi sessions and the sandbox, drives improvement runs,
and heartbeats. `RADULF_ROLES` selects one or both; `make dev` and the tests
run both in one process. There is no queue service: coordination is rows in
SQLite, and there are no subprocesses for agent work — the pi SDK is a
library call.

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

Boot is `src/server/boot.ts`, called from `src/instrumentation.ts` under Next
and from `src/worker.ts` (`make worker`) as a plain Node process. `RADULF_ROLES`
(`web`, `worker`, default both) decides what runs. A worker-only process
ensures the auth secret, runs the sandbox preflight (once, cached), then
recovery, the queue pump (event-driven plus a short timer), the stages,
improvement-run drivers, schedules, retention and the shutdown drain, and
listens on no port. Several workers can run at once against the same database;
the pieces that make that safe are:

- **The claim.** A card is claimed in one `BEGIN IMMEDIATE` transaction in
  `src/server/orchestrator.ts` (`claimLoopRun`, `claimPendingEvaluation` and
  their siblings): it re-reads the card's status and the repo's pipeline load
  inside the transaction, transitions the card, and inserts the `runs` row
  stamped with `runs.worker_id` in the same step. Two workers pumping the same
  repo cannot both start the card, because only one `UPDATE ... WHERE status =
  'ready'` lands, and the per-repo cap is checked from the database rather than
  from any process's memory.
- **The heartbeat.** Each process registers a row in the `workers` table
  (`src/server/workers.ts`) and refreshes it every
  `RADULF_HEARTBEAT_INTERVAL_MS`. A worker whose row is older than the
  `workerStaleSeconds` setting is dead as far as everyone else is concerned.
  The stale reaper `reapStaleRuns` runs continuously on every worker's
  heartbeat tick (and once at boot with `orphans: true`, covering runs with no
  `worker_id` left by a restart): it finishes a dead worker's `running` run as
  `interrupted` with a compare-and-set on `status = 'running'`, so two reapers
  never both finalize it, then hands the card to `parkOrResume` — a
  checkpointed loop goes back to Ready and the pump opens a fresh run on the
  first unchecked task, while every other kind of run parks the card in Needs
  Attention. It also parks cards whose claimed review delivery died mid-merge
  — unless the card is already `done` (or the run has an approved `reviews`
  row), which means the merge landed before the worker died: then the
  delivery is finished as landed (`ok = 1`, `review.decided` payload carries
  `recoveredAfterWorkerLoss: true`) and the card is left alone, while the
  worktree, branch and integrity baseline the worker never got to remove are
  reclaimed by the workers' finished-card worktree sweep
  (`removeFinishedWorktrees` in `src/server/retention.ts`, run on every pump
  tick for `done` and `abandoned` cards) — and deletes the stale `workers`
  rows. A worker that is stopped deliberately
  does not wait for a peer to notice: `releaseOwnedWork()` (called from the
  shutdown drain in `src/server/shutdown.ts` on both the clean and the
  timed-out path) stops its own timers, runs the reaper's per-run and
  per-delivery bodies over its own `running` rows with exit reason `worker
  shut down before this stage finished`, releases its `repo_leases` rows and
  deletes its own `workers` row before `process.exit`.
- **The control column.** A web process holds no `AbortController` for a run
  another process owns, so cancel, reset and pause also write the nullable
  `runs.control` column (`cancel` | `pause`); the owning worker polls that
  column every `RADULF_CONTROL_POLL_INTERVAL_MS` ms (default 1000) for the runs
  whose controller it holds, fires its local abort on `cancel`, and observes
  `pause` at the loop's iteration boundary (spec 25 decision 4).
- **The events tail.** `src/server/eventsTail.ts` re-emits other processes'
  rows from the `events` table onto the local bus, which is how a web process
  learns what a worker did — see [Events and the UI](#events-and-the-ui).
- **Claimed delivery.** Approving a card in a web process moves it to
  `reviewing` and enqueues a `review_deliveries` row; a worker claims that row,
  takes the repo's `repo_leases` row before running the merge or pull-request
  delivery, and records the base branch's new oid in `ref_writes` (spec 25
  decision 6). See [Git](#git).

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
for runs — its `UPDATE` is conditioned on `status = 'running'` — and its
boolean return is what lets the disk watchdog, the abort guard and a cancel
from another process agree on who finalized a run: the first terminal cause
wins and only it emits `run.finished`.

Card statuses are `CARD_STATUSES` in `src/db/schema.ts` — thirteen of them, and
the mapping to the five board columns is in the comment above the list.
`planning`, `ready`, `looping`, and `evaluating` all render as In Progress;
`reviewing` renders as nothing at all, because it is a short-lived atomic claim
on a review decision rather than a state a card rests in.

## The five roles

Each role is a service with one entry point, and each constructs its own pi
session. The role is what decides the tool set — see the capability split below.
The plan critic runs under the planner's tool set (writes confined to `.ralph/`,
no bash) and the post-run check rejects any change other than `.ralph/CRITIQUE.md`.

| Role | Module | Entry point | Timeout |
|---|---|---|---|
| Scoping | `src/server/scoping.ts` | `scopingTurn(cardId, content)`, `proposeScopedCard(cardId)`, `proposeSplit(cardId)`, `proposeScopedPlan(cardId)` | 5 min per turn |
| Planner | `src/server/planningService.ts` | `runPlanning(cardId)` | `plannerTimeoutMinutes` setting, 30 min default |
| Plan critic | `src/server/planCriticService.ts` | `runCritic(cardId)` | `criticTimeoutMinutes` setting, 10 min default; read-only review of a finished plan (spec 30), run when `planCriticMode` or the card's `planCritic` override says so |
| Loop | `src/server/orchestrator.ts` | `runLoop(cardId)` (private) | per-card, default 60 min |
| Evaluator | `src/server/evaluationService.ts` | `runEvaluator(cardId)` | `evaluatorTimeoutMinutes` setting, 10 min default; reads the repository gate result the loop's DONE path left in `.ralph/GATE.md` (spec 29), and runs the gate itself through `gate.ts` only when that file is missing, under `gateTimeoutMinutes` |

Scoping is not a pipeline stage (spec 17): it runs on demand from the card's
API route, outside the orchestrator's slots, as a read-only session against the
repository checkout. Its thread lives in `scoping_messages` and is rendered
into the planner's prompt; a planner run that raises `QUESTIONS.md` appends
them to the same thread.

A session ends by producing one of three concrete things, and the last two are
the orchestrator's to apply because they change card state:

| Output | Route | Applied by |
|---|---|---|
| A scoped card | `POST /api/cards/:id/scoping/proposal` | the operator, as a card `PATCH` |
| An ordered split | `POST /api/cards/:id/scoping/split` | `applyScopingSplit` — the card becomes the first piece, the rest are queued after it |
| The plan itself | `POST /api/cards/:id/scoping/plan` | `adoptScopingPlan` — a plan row stamped `origin: "scoping"`, no planning run |

A split is a proposal and never an action: the same POST with a `cards` body
applies the operator's own edited version of it. It is refused once the card
has a plan, which would otherwise leave the pieces running a plan for the
scope they no longer have. A scoping-authored plan needs the card's
`scopingAuthorsPlan` flag and still honours `reviewPlanBeforeImplementation`,
so it is the plan-review gate, not a second approval step, that puts a human
in front of it.

The loop is not a separate service — it is the orchestrator's own method,
because it is the thing the pipeline slots exist to meter.

`src/server/reviewService.ts` is a service too but not an agent role: it
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
gate, then run the acceptance-criteria probe, then merge the base branch into
the worktree (`baseSync.ts`, after waiting for the repo's delivery lease to be
free; a base whose history was rewritten under the branch first gets the
branch's own commits replayed onto its new tip; a conflict becomes a resolve
task for the loop and the next bookkeeping commit completes the merge), then run the repository gate (`gate.ts`; a failure
becomes a repair task), and only then hand to the evaluator. Sync conflicts and
gate failures together get at most two rounds per run (spec 29).

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

## Provider logins

`src/server/providerLogin.ts` drives `ModelRuntime.login` from a route so a
subscription can be connected from Settings rather than from a TUI over
`docker exec` (spec 23). pi's login takes an `AuthInteraction`, which is two
callbacks: `notify` for what the operator should see and `prompt` for what
they must answer. The TUI is one implementation; this module is another.

A session is a held promise. `login()` runs for the whole flow, and each
`prompt()` parks on a promise the module resolves when the browser posts an
answer, so at most one question is outstanding. Each prompt carries a fresh
token, because an answer that arrives after the flow moved on must not resolve
whatever replaced its question, and a prompt can be **withdrawn** rather than
answered: on a host install the loopback callback can win the race against the
paste box, and pi aborts the prompt it was offering.

Read back by polling, not over the SSE bus, which every open tab receives and
which must never carry an `auth_url` and its PKCE state. Sessions are
in-memory, expire on their own, and are limited to one per provider, because
the Anthropic flow binds a fixed callback port. Radulf never sees a token: pi
writes and refreshes its own `auth.json`.

## Card export and import

`src/server/cardTransfer.ts` moves a card between installs as a versioned
JSON file. What travels is the card's intent: its title, description, the
per-card settings, and its scoping thread, which spec 17 calls the durable
record of why the card is shaped the way it is. What does not travel is
anything that happened — runs, iterations, transcripts, reviews and worktree
paths describe one machine's execution. Plans are left out on purpose: a plan
is written against one checkout at one commit, so importing one would land a
card claiming to be planned for a repository the plan has never seen.

An import always creates fresh ids in Backlog, and the request, not the file,
names the target repository. A `baseBranch` the target does not have falls
back to its default with a note in the response, rather than failing the whole
file over a branch name that only meant something where it came from.

## Scheduling

`src/server/schedules.ts` is the whole scheduler (spec 22), ticked once a
minute from `src/server/boot.ts` in every process with the `worker` role — no
worker is elected to own it. A schedule starts only what a button starts, by
the path a button takes: `queue-drain` calls `startCard` on every
card waiting in the Queue, and `improvement-run` calls `createImprovementRun`
with the arguments stored on the schedule. Every cap those paths enforce still
applies, and no schedule merges anything.

Expressions are five-field cron, server-local, parsed by
`src/server/cron.ts` — written here rather than taken from npm, and the one
place the day-of-month/day-of-week OR rule lives. `fireDueSchedules` compares
`lastFiredAt` at minute resolution, so a tick that runs twice in a minute
cannot start the same work twice, and a tick the server was down for is missed
rather than replayed. Because the tick runs in every worker,
`claimScheduleFire` is a compare-and-set on `lastFiredAt`: the `UPDATE` is
conditioned on the value the tick read, so of any number of workers holding
the same snapshot exactly one sees a changed row and fires; the rest run,
record and emit nothing. Two workers never fire a schedule twice. A firing that throws is recorded on the schedule and
emitted as `schedule.fired`; the schedule stays enabled, because a provider
outage must not silently cancel the cadence that would have picked the work
back up.

## Git

`src/server/git.ts` wraps every git call. Each run gets a worktree on its own
branch (`createWorktree`), so your checkout is untouched until a merge. Every
host-side call pins `core.hooksPath=/dev/null` and `core.fsmonitor=false`:
these run unsandboxed in a worktree the agent has just written to, and a
relative `core.hooksPath` (husky's) resolves against that worktree. Your own
hooks therefore do not run on Radulf's merge commits; the reviewed diff is the
gate. `offRunBranchReason` refuses to commit into a worktree that has left its
run branch or whose `.git` pointer no longer leads to the repository.

`mergeBranch` is the one write to the user's repo. Before touching anything it
looks for a merge already in progress in the parent checkout: if `MERGE_HEAD`
is this run branch (a delivery worker died between `merge --no-commit` and
`commit`) it runs `git merge --abort` and starts over; any other `MERGE_HEAD`
is refused with an error naming the repo path. If the run branch is already an
ancestor of the base (the worker committed but died before the DB write) it
returns `alreadyMerged: true` with the existing merge commit and moves no ref.
Otherwise it checks out the base branch, refuses a dirty tree (the error names
the repo path and tells the operator to commit or stash and press Retry merge),
merges `--no-ff --no-commit` so `.ralph/` can be dropped before committing, and
restores your original branch on every path including failure. It distinguishes a content conflict (`conflict: true`,
recoverable — the card goes back to the loop via `mergeBaseIntoWorktree`) from
an unrecoverable failure. It carries no lock of its own: the caller holds the
repo's `repo_leases` row (`src/server/repoLeases.ts`), which serializes merges
per repo across processes, and records the base branch's new oid in
`ref_writes` so sibling runs' run-end integrity checks do not read the move as
tampering.

## Persistence

`src/db/schema.ts`, Drizzle over SQLite, created on first run with no manual
migration step. Sixteen tables: `repos`, `cards`, `plans`, `scopingMessages`,
`runs`, `workers`, `iterations`, `reviews`, `events`, `improvementRuns`,
`schedules`, `settings`, `worktrees`, `reviewDeliveries`, `repoLeases`,
`refWrites`.

Transcripts are **not** in the database — they are JSONL files on disk, read in
chunks by `src/server/transcript.ts` (`TRANSCRIPT_CHUNK_BYTES`, 512 KB). A long
run's transcript is far too big for a row.

Settings is a key/value table, read synchronously via `getSettings()`. Provider
credentials live there and flow into the session at runtime; the agent's shell
runs with a scrubbed env (`agentEnv`) so it cannot read them.

The retention sweep (`pruneRuntimeHistory` in `src/server/retention.ts`) runs
hourly in every worker, but prunes only when `claimDailySweep` wins the day's
marker: an upsert of the `settings` row `retentionSweepDay` that writes only
when the stored day differs from today's, so the first worker to call on a
given UTC day sees one changed row and every later caller sees zero. Exactly
one worker prunes per day, however many are running.

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

Every process also runs the events tailer in `src/server/eventsTail.ts`,
started from `src/server/boot.ts` for every role. It polls the `events` table
every `RADULF_EVENTS_TAIL_INTERVAL_MS` ms (default 500) for rows with an id past
the last one it saw and re-emits them on the local bus, skipping ids the process
emitted itself (`wasEmittedLocally` in `src/server/events.ts`) so no local
consumer sees an event twice. The tailer writes nothing: the `events` table
stays the only durable copy, and this is how a web-only process learns what a
worker-only process did.

Live transcript pushes are owned by the web role. `src/server/transcriptWatchers.ts`
keeps exactly one `startTranscriptPush` watcher per run in status `running` per
process — never one per SSE client. A watcher starts when the bus delivers
`run.started`/`iteration.started` for that run, or when a periodic scan every
`RADULF_TRANSCRIPT_SCAN_INTERVAL_MS` ms (default 5000) of the `runs` table finds
it; for a loop run it follows the latest iteration file. It stops on
`run.finished` or when the row is no longer running. The stage runner
(`src/server/stage.ts`) no longer starts a push; scoping turns
(`src/server/scoping.ts`) still start their own because they stay in the web
process. The SSE route `src/app/api/events/stream/route.ts` still broadcasts
every push to every client and the browser filters by run id. In the default
single process both roles share one registry, so no line is pushed twice.

`src/app/api/events/stream/route.ts` is the SSE feed the board subscribes to,
with a 25s heartbeat. This is why the board updates without polling.

## Improvement Runs

`src/server/improvementRuns.ts` sits *above* the orchestrator rather than inside
it: `driveRun(runId)` is a loop that proposes one card
(`improvementProposer.ts`), creates it, and waits for it to reach a terminal
status (`awaitCardTerminal`) before proposing the next. It uses the same single
pipeline slot as everything else.

`driveRun` first claims the run through `src/server/improvementRunLeases.ts`,
which stamps `improvement_runs.worker_id` and `heartbeat_at`; it heartbeats
the lease while driving and releases it on exit. A run whose driver's worker
goes stale (`workerStaleSeconds`, judged against `heartbeat_at`) is adopted by
whichever other worker's pump tick next sees the still-`running` row, and a
driver that finds its lease taken over stops rather than proposing into a run
another worker now owns.

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
