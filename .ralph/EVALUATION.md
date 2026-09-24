VERDICT: approve

## What I verified

Every command in the acceptance criteria was run in this worktree and matched its expected outcome (full log in `.ralph/EVALUATION-NOTES.md`):

- **Lease wait, not acquire** — `grep -c 'acquireRepoLease'` → 0; `grep -c 'releaseRepoLease('` → 0; no `acquireRepoLeaseWithin`; `await waitForRepoLeaseRelease(repo.path, LEASE_SETTLE_MS)` present; `import { releaseStaleLeases } from "./repoLeases";` present; no "repo lease held by a delivery for over"; `recordTaskCompleted` doc comment sits directly above the function.
- **Previous behaviour preserved** — `syncWithBase`, `MAX_SYNC_GATE_ROUNDS = 2`, `runGateCommand`, `gateRepairTaskText` all present. `vitest orchestrator.lifecycle.test.ts -t "spec 29"` → 7 passed; full file → 111 passed. `baseSync/gate/acceptanceProbe/checklist/git/integrity` → 83 passed. `mockPipeline.test.ts` → 13 passed including `base-conflict`. `evaluationService.test.ts -t "spec 29"` → 1 passed; the whole file also passes (23 passed, 1 skipped) — the order-dependent pollution the criteria anticipated did not appear. `git diff --name-only beta...HEAD -- src/server/harness/` → exactly `src/server/harness/mock.ts`; `reviewService.ts` untouched.
- **Spec text** — `# 29: ` heading; "waits for the repository's delivery lease" present, "takes the repository's delivery lease" absent; old killed-gate sentence absent, "without a loop's DONE" present; zero occurrences of `28`; DESIGN_HISTORY row for 29 (line 67) sits after the row for 27 (line 65).
- **Type and lint** — `npx tsc --noEmit -p tsconfig.json` → 0; `npx eslint` on the five named files → 0.
- **Whole card** — full `vitest run`: 138 files / 1328 tests passed, exit 0. The orchestrator-run gate (`make lint typecheck build check-split`) exited 2 on one `splitProcesses.test.ts` assertion (`pushes.length` of live-transcript SSE frames was 0) while the card in that same test went loop `done-signal` → evaluate `approve` → review; the identical gate passed with exit 0 at both earlier evaluations of this branch, and a single rerun of `RADULF_SPLIT_CHECK=1 vitest run src/server/splitProcesses.test.ts` passed 9/9. That failure is a timing flake in code this card does not touch, so `make check` is effectively green.

Code review beyond the criteria: the DONE-path ordering is integrity → install gate → acceptance probe → lease wait → `syncWithBase` → gate → evaluation, matching spec 29 and ARCHITECTURE.md. `syncWithBase` uses `merge-base --is-ancestor` to skip a no-op, `merge --no-ff` for a real merge commit, leaves conflicts in progress and aborts any other merge failure. The next iteration's `git add -A && git commit` completes the in-progress merge (verified by the e2e test's `--merges` assertion), and `hasIterationWorkProduct` treats the dirty pre-state as work, so the conflict round cannot be judged a phantom. A gate with `exitCode null` (killed/unrunnable) records `.ralph/GATE.md` and proceeds to evaluation per spec 27 decision 5. Round counting gives two repair rounds and fails on the third, with `abortMerge` before `fail` on the conflict path. `evaluationService.ts` no longer clears `GATE.md`; the loop start clears it instead, so a retry and a first attempt alike reuse the loop's result.

Doc reconciliation on approve: one phrase in `docs/HOW_IT_WORKS.md` said the gate runs "under the evaluator's sandbox"; the DONE path runs it under the loop run's sandbox context, so it now says "under the run's sandbox".

## For the human reviewer

- A run cancelled or timed out *during* a conflict-resolution iteration leaves the worktree mid-merge (`MERGE_HEAD` present). A retry reuses the worktree; loop start does not abort that merge, so the `ralph: sync plan` commit fails silently and the first iteration's bookkeeping commit completes the merge with whatever the files contain. Rare and caught downstream by gate/evaluator, but worth a follow-up card.
- `src/server/gate.ts`'s header comment still describes the gate as running "under the evaluator's sandbox context … once per evaluation cycle"; source is outside the evaluator's writable set, so it was left as is.

```findings
[
  { "severity": "important", "file": "src/server/orchestrator.ts", "line": 1706, "issue": "A reused worktree left mid-merge by a run that ended during a conflict round is not aborted at loop start, so the plan-sync commit fails silently and the first bookkeeping commit completes the merge with whatever the conflicted files hold." },
  { "severity": "suggestion", "file": "src/server/gate.ts", "line": 11, "issue": "Module header comment still says the gate runs under the evaluator's sandbox once per evaluation cycle; since spec 29 it primarily runs in the loop's DONE path under the run's sandbox." }
]
```
