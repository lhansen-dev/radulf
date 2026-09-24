VERDICT: approve

## What I verified (every command run myself)

Static criteria — all pass:
- `grep -n 'control: null' src/server/orchestrator.ts | wc -l` → `2` (the `applyControlSignals` clear and the `runLoop` `finally` clear).
- `awk '/this.controllers.delete\(runId\);/{f=1} f && /eq\(runs.control, "cancel"\)/{print; exit}'` → prints the one `finally` line that clears a pending cancel after the controller is deleted.
- `grep -q 'if (!this.finishRun(active.id, status, reason)) return;'` → succeeds (`endActiveRun` honours the CAS; when a peer finalized first it skips `failIterations`, the `control` write and the abort).
- `grep -q 'SELECT id FROM iterations WHERE run_id = ?' src/server/splitProcesses.test.ts` → succeeds; `grep -c 'SELECT id FROM iterations WHERE run_id'` → `1` both before and after `make check-split` (the fix was not reverted).
- `grep -c 'a cancel the worker.s poll never saw is still consumed' …lifecycle.test.ts` → `1`; `grep -c 'does not fail iterations or write control when a peer finished the run first' …roles.test.ts` → `1`.
- `git diff --stat $(git merge-base HEAD beta)...HEAD -- src/server/harness/` → empty. Harness untouched; the worker fires the existing `AbortSignal`.

Dynamic criteria — all pass:
- `npx vitest run src/server/orchestrator.lifecycle.test.ts` → exit 0, 102 passed. The diff to this file is purely additive (103/0), so the existing suite is unchanged in the single-process default.
- `npx vitest run src/server/orchestrator.roles.test.ts` → exit 0, 14 passed (only the `@/db` import line changed among existing lines).
- `npx tsc --noEmit` → exit 0. `npx eslint` on the four listed files → exit 0.
- `make build && make check-split`: repository gate exit 0 (cancel 1000 ms, pause/resume 1276 ms) plus two more runs by me, both exit 0 — cancel 760 ms / 653 ms, pause-resume 1279 ms / 933 ms, 8/8 each time. The cancel test asserts status `cancelled`, `control` cleared, `exit_reason = "cancelled by user"`, exactly one `run.finished`, every iteration `failed`, and the run's scratch dir removed.
- Full `npx vitest run` once (exit 1): 128 files passed; the 5 failing files are exactly the environmental list (`bookkeeping.test.ts` EROFS on `/tmp`, `harness/index.test.ts` 10× "runHarness watchdogs" `mkdir /tmp/ralph-stall-test`, `streamLiveness.test.ts` 2× `/tmp/ralph-liveness-test`, `srt.test.ts` 4× real-runtime rows, `evaluationService.test.ts` 3× timeout/gate). Nothing card-related.

Code review against the card's description:
- Migration `drizzle/0019_far_hawkeye.sql` is a single nullable `ALTER TABLE runs ADD control text`; the 0019 snapshot chains `prevId` to 0018's id and differs only by that column.
- Cancel and reset go through `endActiveRun` (CAS `finishRun` → `failIterations` → `control = 'cancel'` → local abort); pause/pauseEpic move the card then `requestPause` writes `control = 'pause'` on the card's running run. Abandon still refuses while a run is active and restart is only allowed from `needs_attention` (no live run) — identical to today, as the card allows ("where that is the current behavior").
- The worker (non-passive only) polls `runs.control` for runs whose controllers it holds (loop, plan and evaluate stages all register controllers), aborts on `cancel` and clears it; the loop reads `control === 'pause'` at the iteration boundary alongside the card status. The poll timer is guarded, `unref`'d, and cleared in `startDraining`.
- First-terminal-cause-wins: `finishRun` updates `WHERE status = 'running'` and returns false on `changes !== 1` without emitting `run.finished`; both `fail()` in `runLoop` and `endActiveRun` honour it.

## For the human reviewer

- After a pause lands, the paused run row keeps `control = 'pause'` (the split test asserts this). Harmless — nothing reads it once the run is terminal — but it means the column is not strictly "null when nothing is pending" for paused runs.
- `endActiveRun` writes `control = 'cancel'` in a separate statement after `finishRun`; if the owning worker's `finally` runs in between (run ended on its own in that instant), a stale `cancel` can remain on the terminal row. Cosmetic only: the poll considers only runs whose controllers are held.
- Plan/evaluate stages (`planningService.ts`, `evaluationService.ts`) release their controller but do not clear a stale `control = 'cancel'` the way `runLoop`'s `finally` does. Same harmlessness as above.
- `resetCard` writes `control = 'cancel'` and then deletes the run rows; reset is only permitted from statuses with no live run, so this matches today's behaviour.

```findings
[
  { "severity": "suggestion", "file": "src/server/orchestrator.ts", "line": 886, "issue": "control = 'cancel' is written in a separate statement after finishRun's CAS, so a worker whose runLoop finally ran in between can leave a stale cancel on a terminal run row (cosmetic; nothing reads it)." },
  { "severity": "suggestion", "file": "src/server/orchestrator.ts", "line": 2083, "issue": "A paused run keeps control = 'pause' after the pause is applied; consider clearing it in the pause branch so the column is null whenever nothing is pending." },
  { "severity": "suggestion", "file": "src/server/planningService.ts", "issue": "Plan/evaluate stages release their controller without clearing a stale control = 'cancel', unlike runLoop's finally; harmless but asymmetric." }
]
```
