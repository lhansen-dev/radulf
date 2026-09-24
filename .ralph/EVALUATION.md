VERDICT: revise

## Summary

The core of the card is implemented and works: `workers` table + heartbeats, `runs.worker_id`, a `BEGIN IMMEDIATE` loop claim (`claimLoopRun`) and pending-evaluation claim (`claimPendingEvaluation`), `cards.evaluation_pending`, pause as a card status, `reapStaleRuns()` as the continuous reaper and boot recovery's first pass, a live-run-aware scratch sweep, and `workerStaleSeconds` with a `[15, 86400]` floor. The repository gate (`make lint typecheck build check-split`) passed on HEAD `8690898`, including the two-worker split check with cap contention and SIGKILL handover. The new unit suites (`workers`, `orchestrator.claim`, `orchestrator.reaper`, `orchestrator.roles`) pass and `orchestrator.lifecycle.test.ts` passes 98/98.

Two acceptance criteria fail concretely, one of them a real regression the loop never noticed because it never re-ran the scoping suite after task 3.

## What must change

### 1. `src/server/orchestrator.scoping.test.ts` regressed (4 failures) — acceptance criterion fails

```
$ npx vitest run src/server/orchestrator.scoping.test.ts
 × adoptScopingPlan > stamps the plan as scoping-authored and readies the card without a planning run
   AssertionError: expected 'looping' to be 'ready'      (orchestrator.scoping.test.ts:255)
 × adoptScopingPlan > sends an opted-in card to plan review when it asked for one
 × adoptScopingPlan > refuses a plan whose checklist has nothing to run, and writes no row
 × adoptScopingPlan > refuses a card past scoping before it spends a model turn
   SqliteError: FOREIGN KEY constraint failed              (beforeEach, db.delete(plans) at line 66)
 Tests  4 failed | 9 passed (13)
```

This file passes 13/13 on a `git archive beta` export in the same environment, so it is caused by this card. Cause: `adoptScopingPlan()` (orchestrator.ts ~line 830) moves the card to `ready` and calls `this.pump()`; `pump()` now claims the card **synchronously** via `claimLoopRun()` — the card is `looping` and a `running` run row referencing the plan exists before `adoptScopingPlan` returns. Before the card, the ready→looping move happened after `runLoop`'s awaited worktree setup, so the card still read `ready`. The three later tests then fail because `beforeEach` deletes `plans` while the leaked run row still references `plan_id`.

Fix (test-side; the behaviour change is what the card asked for): in `src/server/orchestrator.scoping.test.ts`
- update the first `adoptScopingPlan` test to accept the synchronous claim — assert `allCards()[0].status` is `looping` (or `["ready","looping"]` contains it) and that a `runs` row with `kind = "loop"` and `workerId = orchestrator.workerId` exists for the card, or stub `pump` for that test; and
- make `beforeEach` delete `iterations`, `runs`, and `workers` before `plans`/`cards` so a claimed run row cannot break the following tests.
Then run `npx vitest run src/server/orchestrator.scoping.test.ts src/server/planningService.test.ts src/server/evaluationService.test.ts src/server/stage.test.ts src/server/mockPipeline.test.ts src/server/settings.test.ts` and confirm only the three pre-existing `evaluationService.test.ts` spec 26/27 failures remain (those fail identically on `beta` in this nested sandbox and are not counted here).

### 2. The removed in-memory identifiers must not appear in `src/server/orchestrator.ts` — three acceptance criteria fail

```
$ grep -q 'activeLoopCards' src/server/orchestrator.ts;   echo $?   → 0   (expected 1)
$ grep -q 'pendingEvaluations' src/server/orchestrator.ts; echo $?   → 0   (expected 1)
$ grep -q 'pausedCards' src/server/orchestrator.ts;        echo $?   → 0   (expected 1)
```

Task 8 misread the check: the criteria require these greps to FAIL (the fields are gone, which is correct), but the class-level JSDoc added above `export class Orchestrator` (orchestrator.ts lines ~236–256) spells out the old identifiers `activeLoopCards`, `pendingEvaluations`, `pausedCards` verbatim. Reword that comment so none of the three tokens appears — e.g. "the former in-memory set of cards being started", "the former in-memory pending-evaluation map", "the former in-memory pause set" — and re-run the three greps expecting exit 1. Do not reintroduce the fields. (`specs/02-architecture.md` may keep its mention; the check is scoped to `orchestrator.ts`.)

## Should also be fixed (not disqualifying on their own)

3. **Heartbeat is an UPDATE, not the upsert the card asks for** — `src/server/workers.ts` `heartbeatWorker()`. If a live worker stalls past the stale window (default 120 s, floor 15 s) a peer reaps its runs and deletes its `workers` row. When the stalled worker resumes, `UPDATE workers SET heartbeat_at ...` matches zero rows, so it never re-registers; every run it claims afterwards has a `worker_id` with no row and is reaped by the peer within one heartbeat tick (`run.workerId !== null && live.has(run.workerId)` is false). Make `heartbeatWorker` an `insert(...).onConflictDoUpdate({ target: workers.id, set: { heartbeatAt } })` carrying host/pid/roles/startedAt, so a reaped-but-alive worker heals itself.

4. **The continuous orphan sweep parks `reviewing` cards the live process is still delivering** — `reapStaleRuns()` orphan block (orchestrator.ts ~lines 485–515). Before this card, parking `reviewing`/run-less cards happened only in boot `recover()`. It now runs every heartbeat tick in the live process, and a `reviewing` card has no run row to prove ownership, so any merge/PR delivery that takes longer than `workerStaleSeconds` (trivially reachable at the 15 s floor; plausible on a slow push) is moved to `needs_attention` mid-delivery by the same process, and `ReviewService`'s own `reviewing → done` CAS then fails. Either restrict the orphan pass to `recover()` (boot), or skip `reviewing` in the continuous pass until spec 25 decision 6 gives delivery a lease row.

5. **The heartbeat/reaper interval can never be stopped** — constructor in `orchestrator.ts`. Every `new Orchestrator()` (one per test in the lifecycle, claim, reaper, roles suites) leaves a 5 s `setInterval` running that calls `reapStaleRuns()` against the shared test DB. Several lifecycle tests seed `running` run rows without a `worker_id`; on a machine where the suite takes longer than 5 s an earlier test's orchestrator will reap them mid-test ("server restarted mid-run"). Add a `stopHeartbeat()`/`dispose()` (clearing the interval) and call it from the test `afterEach` hooks alongside the `__radulfOrchestrator` reset; `startDraining()` can keep heartbeating as intended.

6. **The todo→planning path still checks the cap outside a transaction** — `pump()` → `startCard()` → `pipelineBusy()` then `moveCard(todo → planning)` (and the non-queued branch of `approveInstallScripts()` / `retryFailedStep()` do the same for `evaluating`/`looping`). The CAS on card status prevents a double start of one card, and both workers try the same first candidate, but two workers can each pass the load check and move two different Todo cards of one repo into `planning` with a cap of one. The card's scope says claiming a card is one `BEGIN IMMEDIATE` transaction that re-reads the load; wrap the todo→planning move in the same `db.transaction(..., { behavior: "immediate" })` + `loadFor(repoId, tx)` shape as `claimPendingEvaluation`.

## Verified

- Gate `make lint typecheck build check-split` exit 0 on HEAD (tsc, eslint, split check with 5 tests incl. "two workers never run two runs of one repo at once with a cap of one" and "SIGKILL on a worker mid-loop hands the card to the other worker within the stale window").
- `npx vitest run src/server/workers.test.ts src/server/orchestrator.claim.test.ts src/server/orchestrator.reaper.test.ts src/server/orchestrator.roles.test.ts` → 25/25 pass.
- `npx vitest run src/server/orchestrator.lifecycle.test.ts` → 98/98 pass.
- greps for `behavior: "immediate"`, `reapStaleRuns`, `workerStaleSeconds` (orchestrator), `workerStaleSeconds: [15` (settings), `workerId` (planning + evaluation services) all succeed.
- `git diff --quiet $(git merge-base HEAD beta) -- src/server/harness src/server/sandbox` → unchanged (base branch is `beta`; the diff vs `main` is only `beta`'s own lead).
- `evaluationService.test.ts` has 3 failures (spec 26/27) that reproduce identically on `beta` in this sandbox — environmental, not counted.

```findings
[
  { "severity": "critical", "file": "src/server/orchestrator.scoping.test.ts", "line": 255, "issue": "Four adoptScopingPlan tests fail (passes on beta): pump() now claims the card synchronously so it reads `looping` with a run row, and the leaked run row breaks the following tests' beforeEach on a plans FK; acceptance command `npx vitest run src/server/orchestrator.scoping.test.ts ...` exits 1." },
  { "severity": "critical", "file": "src/server/orchestrator.ts", "line": 242, "issue": "Class-level JSDoc spells out `activeLoopCards`, `pendingEvaluations`, `pausedCards`, so the three acceptance greps that must exit 1 exit 0; reword the comment without the identifiers." },
  { "severity": "important", "file": "src/server/workers.ts", "line": 41, "issue": "heartbeatWorker is a plain UPDATE, not the upsert the card specifies: a worker whose row was reaped during a stall never re-registers and every run it claims afterwards is reaped by a peer within one tick." },
  { "severity": "important", "file": "src/server/orchestrator.ts", "line": 488, "issue": "The orphan-card pass now runs every heartbeat tick and parks `reviewing` cards older than the stale window even while this same process is mid-merge/PR delivery (was boot-only before); restrict to recover() or skip `reviewing`." },
  { "severity": "important", "file": "src/server/orchestrator.ts", "line": 312, "issue": "The heartbeat/reaper setInterval can never be cleared; every Orchestrator constructed in tests keeps reaping the shared DB every 5 s, which will interrupt worker-less `running` rows seeded by later lifecycle tests on a slow machine." },
  { "severity": "important", "file": "src/server/orchestrator.ts", "line": 763, "issue": "todo→planning (startCard) and the non-queued approveInstallScripts/retryFailedStep transitions still check the per-repo cap outside a BEGIN IMMEDIATE transaction, so two workers can plan two cards of one repo under a cap of one." },
  { "severity": "suggestion", "file": "src/server/orchestrator.ts", "line": 1068, "issue": "hasInFlightWork() still uses the global cardInStatus(RUNNING_STATUSES), so a draining worker waits on cards owned by its peer until the drain budget expires." },
  { "severity": "suggestion", "file": "src/server/workers.ts", "issue": "workers.host/pid are recorded but never used; a same-host `process.kill(pid, 0)` liveness probe would make boot recovery immediate in the single-process default instead of waiting out the stale window after a hard crash." }
]
```
