VERDICT: approve

## What I verified

Every acceptance criterion was run by hand and passes:

- **Lease wait, not acquire** (`src/server/orchestrator.ts`): `grep -c 'acquireRepoLease'` → 0; `grep -c 'releaseRepoLease('` → 0; `acquireRepoLeaseWithin` absent; `await waitForRepoLeaseRelease(repo.path, LEASE_SETTLE_MS)` present; import is back to `import { releaseStaleLeases } from "./repoLeases";`; the "repo lease held by a delivery for over" failure is gone; `recordTaskCompleted`'s doc comment (`agrees. */`) sits directly above the function again.
- **Previous-attempt behaviour preserved**: `syncWithBase`, `MAX_SYNC_GATE_ROUNDS = 2`, `runGateCommand`, `gateRepairTaskText` all present. `npx vitest run src/server/orchestrator.lifecycle.test.ts -t "spec 29"` → 7 passed; full lifecycle file → 109 passed; `baseSync`/`gate`/`acceptanceProbe`/`checklist`/`git`/`integrity` tests → 83 passed; `mockPipeline.test.ts` → 12 passed including `base-conflict` (one `base.conflict` event naming `mock-output/task-1.md`, task-3 bookkeeping commit is a merge, approval merges into `main` cleanly); `evaluationService.test.ts -t "spec 29"` → 1 passed. `git diff --name-only beta...HEAD -- src/server/harness/` → exactly `mock.ts`; `reviewService.ts` untouched.
- **Spec text**: title `# 29: …`; "waits for the repository's delivery lease" present, "takes …" absent; the old killed-gate sentence gone, "without a loop's DONE" present; `grep -c '28'` → 0; DESIGN_HISTORY row on line 66, after spec 27 on line 65.
- **Type and lint**: `npx tsc --noEmit -p tsconfig.json` → 0; `npx eslint` on the five listed files → 0. Repository gate (`make lint typecheck build check-split`) exit 0 per `.ralph/GATE.md`.
- The 3 other `evaluationService.test.ts` failures (`honours a complete verdict…`, `still fails a timeout…`, `runs the gate before the evaluator…`) I traced to the unchanged `PLAN.md Phase 18.1 regression` test polluting the harness mock when it runs inside the sandbox: they reproduce with the merge-base's test file and pass in isolation; the new spec 29 test does not cause them (`-t "spec 29|honours…|still fails…|runs the gate before…"` → 4 passed). Pre-existing, as the criteria say — and already fixed on `beta`'s tip by `it.skipIf(insideRadulfSandbox)`.

Code review of the DONE path: order is probe → wait for lease → `syncWithBase` → (conflict: `base.conflict`, resolve task, `continue`; merge left in progress and completed by the next bookkeeping `git add -A && git commit`) → gate → (non-zero: `gate.repair`, repair task, `continue`) → evaluation. Timed-out/unrunnable gate (`exitCode === null`) is recorded to `.ralph/GATE.md` and goes on to evaluation, as spec 29 decision 2 says. Round counter is shared between conflicts and gate failures, third failure ends the run with `sync-and-gate round limit reached: …` and `abortMerge` on the conflict variant. `GATE.md` is cleared at loop start and no longer at the evaluator's fresh cycle, so a loop-written file is reused on first attempt and retry alike; the evaluator drops the section when the repo has no gate command. `syncWithBase` returns `up-to-date` via `merge-base --is-ancestor`, aborts and reports non-conflict merge failures, and uses `--no-ff -m "ralph: merge <base> into <branch>"`. Nothing unrelated to the card changed.

## For the human reviewer

- **`beta` moved under this very branch** (spec 28 graph epics and the "test suite inside the sandbox" card merged since merge-base `620e94e`). In an isolated clone, merging this branch into `beta`'s tip auto-merges `orchestrator.ts` but conflicts in `docs/DESIGN_HISTORY.md` (both sides appended a row after spec 27) and `src/server/mockPipeline.test.ts` (both sides appended a test at the end of the same `describe`). These are keep-both resolutions; the existing `reloopForConflict` path at approval will hand them to the loop. This run itself did not get the spec 29 sync because the orchestrator running it predates the change.
- Conflict resolution relies on the next bookkeeping commit; nothing scans for leftover `<<<<<<<` markers before completing the merge (same as the existing `reloopForConflict` path). The resolve task asks the agent for `git diff --check`, but the orchestrator does not verify it.
- Docs reconciled on approve: `docs/HOW_IT_WORKS.md` (gate paragraph and the "When the loop says it is done" section) and `docs/ARCHITECTURE.md` (evaluator row, run-end ordering) now describe the sync and the pre-DONE gate.

```findings
[
  { "severity": "important", "file": "src/server/mockPipeline.test.ts", "issue": "beta moved since merge-base: merging this branch into beta's tip conflicts in mockPipeline.test.ts and docs/DESIGN_HISTORY.md (both sides appended at the same spot); trivial keep-both resolutions, but approval will not merge cleanly as-is." },
  { "severity": "suggestion", "file": "src/server/orchestrator.ts", "line": 2050, "issue": "No check that conflict markers are gone before the next bookkeeping commit completes the merge; an ITERATION_DONE with markers left would commit them as the resolution." },
  { "severity": "suggestion", "file": "src/server/orchestrator.ts", "line": 2066, "issue": "The run-gate block (gate.started, runGateCommand, write GATE.md, gate.finished) duplicates the one in evaluationService.ts and could share a helper in gate.ts." }
]
```
