VERDICT: revise

## What passes

Every static and unit-level criterion holds; I ran each command myself:

- `src/db/schema.ts`: `control: text("control")` and `export type RunControl = "cancel" | "pause"` present.
- `drizzle/0019_far_hawkeye.sql` is the single file with ``ADD `control` text``; `_journal.json` has `"idx": 19`; `0019_snapshot.json` carries the nullable `control` column.
- `src/server/orchestrator.ts`: `applyControlSignals`, `RADULF_CONTROL_POLL_INTERVAL_MS`, `control: "cancel"`, `control: "pause"` present; `finishRun` updates with `and(eq(runs.id, runId), eq(runs.status, "running"))` (count 1) and returns false without a second `run.finished` when the CAS misses.
- `npx vitest run src/server/orchestrator.roles.test.ts` → 13 passed.
- `npx vitest run src/server/orchestrator.lifecycle.test.ts` → 101 passed (existing suite unchanged + the two new "control signals from a web-only process" tests).
- `npx vitest run src/server/planningService.test.ts src/server/evaluationService.test.ts src/server/reviewService.test.ts src/server/boot.test.ts` → 51 passed, **3 failed in `evaluationService.test.ts`** (timeout/gate tests). I reproduced the identical 3 failures on a pristine `git archive beta` export, and the diff does not touch that file or the service — pre-existing/environmental, not counted against this card.
- `src/server/splitProcesses.test.ts` contains `RADULF_CONTROL_POLL_INTERVAL_MS`, `"stall"`, `"phantom"`.
- `specs/25-web-and-worker-processes.md`: `Amended at implementation (2026-09-24)` in decision 4; `grep -c 'Amended at implementation'` → 2.
- `npx tsc --noEmit` → 0. `npx eslint` on the five listed files → 0.
- `git diff --stat beta...HEAD -- src/server/harness/` → empty (`origin/HEAD` is stale in this clone and points at an unrelated old commit; the merge base with the default branch `beta` is the right reference).

## What fails: the whole-card gate

`make build && make check-split` exits 1 — deterministically, not flakily. The repository gate failed the same way, I reproduced it in the worktree, and I reproduced it a third time in a pristine copy of HEAD outside the worktree:

```
× cancelling a looping card from the web-only process ends the run in the worker 5267ms
Error: timed out after 5000ms waiting for the worker to cancel the stalled run and consume the control signal
```

### Root cause (verified by dumping the DB at the timeout in a scratch copy)

Run row at the timeout: `status = "cancelled"`, `exit_reason = "cancelled by user"`, `control = "cancel"` (never cleared), zero `iterations` rows. Event order for the card:

```
card.moved  ready → looping
run.finished {"status":"cancelled"}        ← the web process's cancel
card.moved  looping → backlog
run.started  {"kind":"loop"}               ← the worker only reaches runLoop's controller registration here
```

The test polls `runs` for `status='running' AND worker_id IS NOT NULL` and cancels within 25 ms of the claim. The run row exists and is claimed at that point, but the worker is still in `runLoop`'s setup (worktree add, plan sync commit, `createRunSandbox`, `snapshotRepoIntegrity`) and has **not yet executed `this.controllers.set(runId, controller)`** (orchestrator.ts ~line 1630). So:

1. `applyControlSignals()` never sees the run — it only selects `inArray(runs.id, [...this.controllers.keys()])`.
2. When the worker gets past preflight it hits the existing `if (!active()) return;` guard (run status is no longer `running`), returns, and `finally` deletes the controller.
3. `control = 'cancel'` is left on the terminal row forever; the test's `run.control === null` condition never becomes true.

Functionally the run *is* ended (one `run.finished`, status cancelled) — but through the pre-existing guard, not through the poll this card adds, and the split test as written can never observe the poll path because it always wins the race against the worker's setup.

### What to change

**1. `src/server/splitProcesses.test.ts`, test "cancelling a looping card from the web-only process ends the run in the worker" (required).**
After `const runId = running.id;` and before the `POST /api/cards/${cardId}/move { to: "backlog" }`, wait until the worker is actually inside the harness so the cancel exercises the poll. The marker that exists today is the first `iterations` row / the `iteration.started` event, emitted at orchestrator.ts ~1767 — after `controllers.set` and immediately before `runWithTranscript`. For example:

```ts
await waitFor(
  () => dbQuery<{ id: string }>("SELECT id FROM iterations WHERE run_id = ?", runId).length > 0,
  60_000,
  "the loop's first iteration to start",
);
```

I applied exactly this change in a scratch copy of HEAD (nothing else changed) and `RADULF_SPLIT_CHECK=1 vitest run src/server/splitProcesses.test.ts` passed 8/8 on two consecutive runs; the cancel test completed in ~1 s with `status = cancelled`, `control = null`, one `run.finished`, and the scratch dir removed — i.e. the worker's poll path works once it is reachable.

**2. `src/server/orchestrator.ts`, `runLoop` `finally` (recommended, small).**
The worker should consume a pending `cancel` on every exit path of a run it owned, not only when the poll happens to fire while the controller is registered. Next to `this.controllers.delete(runId)` in the `finally`, add:

```ts
db.update(runs).set({ control: null })
  .where(and(eq(runs.id, runId), eq(runs.control, "cancel")))
  .run();
```

This closes the claim→registration window observed above so a terminal run is never left carrying a stale `control = 'cancel'`. (Keep `pause` untouched — the split pause test asserts it stays.) Do this *in addition to* fix 1, not instead of it: fix 2 alone would make the current test pass without ever exercising the poll.

**3. Suggestion (not blocking): `endActiveRun`** ignores `finishRun`'s boolean. When a peer process finished the run first (`finishRun` returns false), it still runs `failIterations(active.id, …)` over every iteration of that run and writes `control = 'cancel'`. Consider `if (!this.finishRun(...)) return;` there, so the "first terminal cause wins" rule also protects the iteration rows.

## Notes for the human reviewer

- The unit-level design is sound: verbs move the card and finish the run immediately in the calling process, `finishRun` is a CAS on `status='running'`, the worker polls `runs.control` for runs whose controller it holds and fires the existing `AbortSignal`; the harness is untouched.
- The `run.started` event being emitted *after* the run was already cancelled (see event order above) is pre-existing single-process behaviour too (the setup window has no `active()` check), so it is not a regression of this card.

```findings
[
  { "severity": "critical", "file": "src/server/splitProcesses.test.ts", "line": 590, "issue": "Whole-card gate fails deterministically: the cross-process cancel test issues the cancel before the worker has registered its controller (no iterations row yet), so applyControlSignals never sees the run and `control` stays 'cancel'; wait for the run's first iterations row / iteration.started event before cancelling." },
  { "severity": "important", "file": "src/server/orchestrator.ts", "line": 2098, "issue": "A cancel that lands between the claim and controllers.set() is never consumed: runLoop's finally deletes the controller but leaves control='cancel' on the terminal run row; clear a pending 'cancel' there so every exit path consumes the signal." },
  { "severity": "suggestion", "file": "src/server/orchestrator.ts", "line": 878, "issue": "endActiveRun ignores finishRun's false return and still runs failIterations and writes control='cancel' on a run a peer already finished; return early when the CAS misses." }
]
```
