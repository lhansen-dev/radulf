# 25: Web and worker processes

Decided 2026-09-23. Amends the process model in
[02-architecture.md](02-architecture.md), which describes one Next.js process
hosting the UI, the API, the orchestrator, and the agent sessions. Amends the
in-process hosting note in [13-single-pi-sdk-harness.md](13-single-pi-sdk-harness.md):
pi still runs in-process through the SDK, but the process is now a worker,
never the web server. Amends the process-wide analysis in
[20-concurrent-cards.md](20-concurrent-cards.md), which assumed one process.
Leaves the single-host hosting posture of [08-hosting-auth.md](08-hosting-auth.md)
in place; multi-host is a later spec. No locked decision is reversed.

## Motivation

Three outcomes were prioritised on 2026-09-23, in this order:

1. **Restart survival.** Restarting or redeploying the web process must not end
   an in-flight run. Today boot recovery marks every running run interrupted,
   and a redeploy costs the in-flight loop iteration or the whole plan or
   evaluate run.
2. **Replicas.** Several web processes and several worker processes against one
   data directory on one host, for rolling restarts and for more than one
   machine's worth of agent work later.
3. **Crash isolation.** A crash or out-of-memory in a pi session, the sandbox
   runtime, or a tool must take down at most the process it ran in. Spec 13
   named this risk and deferred a worker-thread sandbox until crashes surfaced
   in practice. This spec resolves it with a process boundary instead.

A harness-only extraction was considered first: an application-owned
invocation contract with the pi implementation behind an adapter, so a process
adapter could follow later. It was rejected because it delivers none of the
three outcomes on its own. The stage run, not the harness invocation, is what
owns the host-local and run-local state: the worktree, the sandbox context and
its scratch directories, the integrity baseline, the disk watchdog, the
iteration loop, and the checkpoint commits. Moving only the invocation would
leave all of that in the web process. Moving the stage run moves the harness
with it, unchanged, and needs no serializable invocation contract because the
inputs of a stage run are already durable: the card, the plan, the run row,
the worktree path, and settings. Spec 13 deleted the earlier adapter seam for
the same reason this spec does not reintroduce one.

## The shape

Two process roles built from one codebase and one image.

- **web** serves the UI and API, authenticates, writes operator intent to the
  database, and streams state to browsers. It never runs an agent session,
  never touches a worktree, and never writes to a repository.
- **worker** claims runs and review deliveries from the database, executes them
  as the stage services do today, heartbeats while it holds them, and writes
  their results. Every pi session, the sandbox runtime, the guarded tools, git
  writes, and the improvement-run drivers live here.

A process runs one role or both. `make dev` and the test suite run both roles
in one process, so local development and the existing lifecycle tests are
unchanged. The split is exercised locally with two web and two worker
processes against SQLite on one host, with no new services.

What already supports this, and is kept: card and run transitions are
compare-and-set writes; the loop checkpoints every iteration with a commit and
a checklist tick, and boot recovery already returns a resumable looping card to
Ready; circuit breaker and provider rate-limit state live in the settings
table; live transcripts are the JSONL file on disk and the events table is the
durable copy of every event; nothing under `src/server` or `src/db` imports
Next.js.

## Decisions

**1. The stage run is the unit of execution.** A plan, loop, or evaluate run is
claimed and executed whole by one worker. The harness contract, `runHarness`,
`pi.ts`, the transcript event model, and the sandbox implementation do not
change.

**2. Workers claim work through the database.** A `workers` table records id,
host, pid, roles, started-at, and heartbeat-at. The queue pump runs in every
worker. Claiming a card is one SQLite transaction opened with `BEGIN
IMMEDIATE`: re-read the card status and the repo's pipeline load, perform the
existing card transition, insert the run row with this worker's id. The
per-repo cap of spec 20 holds across processes without an in-memory guard.
The in-memory sets the pump relies on today, cards being started, cards
waiting to evaluate, and paused cards, become the claim itself, a card column,
and the existing paused status.

**3. Liveness is a heartbeat, and reaping is continuous.** A run whose worker's
heartbeat is older than the stale window is finished as interrupted by
whichever worker notices first, with the compare-and-set boot recovery uses
today. A resumable loop returns to Ready; every other stage goes to Needs
Attention. Boot recovery becomes the reaper's first pass. The stale window is
the only new loss: a run on a dead worker reads as running for up to that long.
It is a setting with a floor.

**4. Control is a column, not a controller.** Cancel, pause, resume, restart,
and install approval remain card transitions the web performs at once, so the
UI never waits on a worker. The frontend also writes a control column on the
run row; the owning worker polls it on a short interval and fires its local
abort controller. The abort path, the transcript ending, and the telemetry are
the ones that exist today, and the first terminal cause still wins when
cancellation and watchdogs race. *Amended at implementation (2026-09-24): the
column is the nullable `runs.control` (`"cancel"` | `"pause"`). A worker
polls it every `RADULF_CONTROL_POLL_INTERVAL_MS` (default 1000 ms, floor 100)
for the runs whose controllers it holds, firing its local abort on `cancel`
and clearing the column; a `pause` is observed by the loop at its iteration
boundary. `finishRun` is a compare-and-set on `status = running`, so the first
terminal cause wins across processes.*

**5. Events fan out through the table.** `emitEvent` keeps writing the row and
emitting on the local bus. Every process also runs a tailer that reads events
past the last id it has seen and emits them on the local bus, so every existing
bus consumer works unchanged. Transcript pushes, started today by the stage
run in the writing process, are started by the web process for each run one of
its SSE clients is viewing, and stopped when the last client leaves or the run
finishes. The chunked reader, cursor protocol, and resync path are unchanged.
*Amended at implementation (2026-09-24): the web process watches every run in
status running — one watcher per run per process, started when the tailer sees
the run start or a periodic scan finds it and stopped when it finishes — rather
than the runs its SSE clients are viewing; there is no client-interest protocol
and the browser is unchanged.*

**6. Review delivery is claimed like a run.** Approve already moves the card to
reviewing before any git work; the frontend stops there. A worker claims the
delivery, takes a per-repo lease row in place of the in-process merge lock,
performs the merge or pull-request delivery, records the refs it moved in a
ref-write table, and finishes the card. A loop running against the same repo
consults that table at its run-end integrity check, which is what the
in-memory live-baseline registry does today within one process.
*Amended at implementation (2026-09-24): the delivery request is a
`review_deliveries` row (pending → running → finished, with the claiming
worker, outcome and error). A worker claims it and takes the `repo_leases` row
in one transaction; a process with the worker role that approves runs the
delivery itself, a web-only process returns once the row exists. Because
`mergeBranch` moves the base branch at `git commit` and records the write only
afterwards, the run-end check waits (bounded) for the repo lease to be released
before judging a moved ref it cannot explain, then re-reads `ref_writes`. The
stale reaper finishes a `running` delivery whose worker stopped heartbeating,
releases its lease and parks the card in Needs Attention — unless the card is
already `done` (or the run has an approved `reviews` row), in which case the
merge landed before the worker died and the delivery is finished as landed
(`recoveredAfterWorkerLoss: true`) with the card left alone; the worktree,
branch and integrity baseline that worker never removed are reclaimed by the
workers' finished-card worktree sweep (`removeFinishedWorktrees`), which covers
every `done`/`abandoned` card with an unreclaimed `worktrees` row.*

**7. Exactly-once background work uses the rows it acts on.** Improvement-run
drivers hold a lease per run with a heartbeat. The schedule tick and the
retention sweep run in every worker and take a compare-and-set on the schedule
row or the sweep marker before acting.

**8. Migrations and boot are safe under concurrency.** Migrations run under an
exclusive database lock. Auth-secret creation uses an exclusive create and
re-reads on collision. A booting worker sweeps only sandbox scratch that
belongs to runs no live worker owns.

**9. Two gaps stay in the web process, named.** Scoping turns remain an
in-process pi session in web, because they are interactive and synchronous;
two frontends can run two turns on one card at once. Provider login sessions
are per process, so a login must finish on the frontend that started it. Login
rate limiting is per frontend. Each moves in a later card.

**10. No Redis in this phase.** On one host SQLite carries the leases, the
control column, and the events tail. Two seams are kept narrow so Redis can
take them at multi-host: event notification and lease storage.

**11. Deployment.** Compose gains a worker service from the same image sharing
the state volume. Only the worker keeps the sandbox security relaxations; the
web container drops them. Each role has its own health check, the worker's
being its heartbeat row. `SIGTERM` on a worker stops claiming, finishes the
current iteration boundary, hands looping cards back to Ready, lets a review
delivery it has already claimed (a seconds-long merge, push or pull request)
run to completion, and exits within the existing budget. `POST /api/restart`
restarts the process it is called on.

## Data model

- `workers`: id, host, pid, roles, started_at, heartbeat_at.
- `runs.worker_id`: the owning worker; null before claim and for historical
  rows. `runs.control`: nullable text, the pending operator signal.
- A card column for a card waiting on a free slot after install approval,
  replacing the in-memory pending-evaluations map.
- `review_deliveries`: the durable delivery request — run, card, repo, the
  status the card came from, who approved, status, claiming worker, outcome.
- `repo_leases`: repo path, holder worker id, acquired_at, for delivery
  serialization.
- `ref_writes`: repo path, ref, sha, written_at, worker id, replacing the
  in-memory live-baseline registry.
- `improvement_runs.worker_id` and heartbeat, for the driver lease.
- Settings: the stale window, with a floor.

## What this does not do

- Multi-host deployment, PostgreSQL, Redis, object storage, or shared
  filesystems. The seams above are where those land.
- Resume a loop mid-iteration. Checkpoint granularity stays one iteration.
- Users, tenants, or credential partitioning.
- Move scoping turns or provider login out of the web process.
- Change what an agent can do, how it is contained, or how its transcript is
  written.

## Verification

Use the scripted mock provider against an isolated fixture repository and a
temporary data directory. A split topology of two web and two worker processes
completes the pipeline from plan through review. Killing a web process at any
point does not end a run, and a restarted web process shows the live transcript.
Killing a worker with `SIGKILL` mid-loop results in the run being marked
interrupted within the stale window, the card returning to Ready, and a
different worker finishing the card without repeating committed iterations.
With a per-repo cap of one, two workers never have two runs of that repo in
flight. Two approvals on one repo from two frontends deliver serially, and a
loop running during a sibling's merge does not report tampering. Two processes
booting a new database version at once produce one migrated database. Every
existing harness, stream-liveness, guarded-tool, and stage lifecycle test
passes unchanged, and `make check` passes.
