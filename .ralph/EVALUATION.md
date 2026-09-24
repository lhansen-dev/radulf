VERDICT: revise

## What fails

Two acceptance criteria fail, both from the loop's task 7 (commit 771d8f6), which replaced the lease *wait* with a lease *acquire* around the base sync in `src/server/orchestrator.ts`:

```
$ grep -q 'waitForRepoLeaseRelease' src/server/orchestrator.ts; echo $?
1                      # expected 0
$ grep -c 'acquireRepoLease' src/server/orchestrator.ts
5                      # expected 0 — "the sync never takes or writes the lease"
```

The card's constraint is that the sync *respects* the per-repo delivery lease when reading the base branch and never writes it. The current code (`acquireRepoLeaseWithin(repo.path, this.workerId, LEASE_SETTLE_MS)` … `releaseRepoLease(...)`, `src/server/orchestrator.ts` ~lines 214–225 and 2041–2054) takes the lease itself. Besides failing the criteria, it adds a new hard failure: `acquireRepoLease` is not re-entrant and refuses while any live worker (including this one, for another card of the same repo) holds the lease, so a delivery that runs longer than `LEASE_SETTLE_MS` (30 s — a PR push, for example) now ends the loop run with `sync with <base> failed: repo lease held by a delivery for over 30s` and parks the card in Needs Attention. The waiting design never fails the run; git ref reads are atomic, so after the settle window it simply proceeds.

## What to change

1. `src/server/orchestrator.ts`, spec 29 block in `runLoop` (after the acceptance probe): replace

   ```ts
   const leased = await acquireRepoLeaseWithin(repo.path, this.workerId, LEASE_SETTLE_MS);
   if (!active()) { if (leased) releaseRepoLease(repo.path, this.workerId); return; }
   if (!leased) { return fail(`sync with ${base} failed: repo lease held by a delivery for over ...`); }
   let sync: Awaited<ReturnType<typeof syncWithBase>>;
   try { sync = await syncWithBase(worktreePath, base, branch); } finally { releaseRepoLease(repo.path, this.workerId); }
   ```

   with

   ```ts
   await waitForRepoLeaseRelease(repo.path, LEASE_SETTLE_MS);
   const sync = await syncWithBase(worktreePath, base, branch);
   ```

   (keep the `if (!active()) return;` that follows). Delete the `acquireRepoLeaseWithin` helper (and its doc comment, which currently sits between `recordTaskCompleted`'s doc comment and the function — put `recordTaskCompleted`'s comment back next to it). Change the import `import { acquireRepoLease, releaseRepoLease, releaseStaleLeases } from "./repoLeases";` back to `import { releaseStaleLeases } from "./repoLeases";` and import `waitForRepoLeaseRelease` from `./integrity` alongside `LEASE_SETTLE_MS` (both are already exported there). Update the comment above the block to say the base is read only once the lease is free, and never written. Check: `grep -c 'acquireRepoLease' src/server/orchestrator.ts` prints 0, `grep -q 'waitForRepoLeaseRelease' src/server/orchestrator.ts` exits 0, `npx vitest run src/server/orchestrator.lifecycle.test.ts -t "spec 29"` passes 7, `npx tsc --noEmit -p tsconfig.json` and `npx eslint src/server/orchestrator.ts` exit 0.

2. `specs/29-sync-and-gate-before-evaluation.md`, decision 1, last sentence: revert "the sync takes the repository's delivery lease for the duration of the read" to say the sync waits for the repository's delivery lease to be free before reading the base and never takes it or writes the base. Task 7 changed this wording; the version from task 1 was correct.

3. Same spec, decision 4: the sentence "The evaluator's own gate step runs only when the file is missing, which is the case for a repository whose gate was killed or could not run" is wrong about the implementation — `runLoop` writes `.ralph/GATE.md` for a timed-out or unrunnable gate too (it writes the file before looking at the exit code, and only a non-zero exit sends the loop back). Reword to: the file is missing only on a path that reaches evaluation without a loop's DONE (for example a run resumed straight into evaluation after the install-script gate), and the evaluator runs the gate itself only then.

Do not touch anything else: everything below passed and should be preserved as is.

## What passed

- Spec file title, DESIGN_HISTORY row after spec 27, no `28-` reference: pass.
- `src/server/baseSync.ts` exports; `npx vitest run src/server/baseSync.test.ts` (4 real-git tests) and `src/server/gate.test.ts` (9): pass.
- Other orchestrator greps (`syncWithBase`, `MAX_SYNC_GATE_ROUNDS = 2`, `runGateCommand`, `gateRepairTaskText`): pass.
- `npx vitest run src/server/orchestrator.lifecycle.test.ts -t "spec 29"`: 7 passed (clean sync, conflict round, conflict limit, gate repair, gate pass, no gate, gate limit); full lifecycle file: 109 passed.
- `acceptanceProbe`, `checklist`, `git`, `integrity` tests: pass. `evaluationService.test.ts`: the new spec 29 reuse test passes; 3 other tests fail (`honours a complete verdict…`, `still fails a timeout…`, `runs the gate before the evaluator…`) but the same 3 fail identically on an unmodified `git archive beta` checkout and pass in isolation — pre-existing order-dependent pollution, not this card.
- `grep -c 'removeRalphFiles(worktreePath, \[GATE_FILE\])' src/server/evaluationService.ts` prints 0; `GATE_FILE` is cleared at loop start instead.
- `"base-conflict"` scenario in `mock.ts`; `git diff beta...HEAD -- src/server/harness/` touches only `mock.ts` (the criterion's literal `git log -n 15` walks pre-branch history and lists 17 files, which is a flaw in the command, not the change). `reviewService.ts` untouched.
- `npx vitest run src/server/mockPipeline.test.ts`: 12 passed, including `base-conflict` (one `base.conflict` event naming `mock-output/task-1.md`, task-3 bookkeeping commit is a merge, approval merges into `main` cleanly).
- `npx tsc --noEmit -p tsconfig.json` exit 0; `npx eslint` on the listed files exit 0.
- Repository gate (`make lint typecheck build check-split`) exit 0 per `.ralph/GATE.md`. Full `npx vitest run` once: 20 failures, all either on the card's environmental list (bookkeeping, harness stall tests, streamLiveness stall tests, srt real-runtime rows), the 3 pre-existing evaluationService failures above, or one `settings/page.test.tsx` 5 s timeout under parallel load that passes in isolation.

## For the human reviewer, next time round

- The conflict round relies on the next iteration's `git add -A && git commit` completing the merge. A loop agent that writes `ITERATION_DONE` without actually removing the markers would have the markers committed as the merge resolution (the merge-in-progress state counts as work product, so the phantom check does not catch it); the same is true of the existing `reloopForConflict` path. Not required by the card, but a cheap `git diff --check` / marker scan before completing the merge would close it.
- `docs/HOW_IT_WORKS.md` ("A repository can declare a gate command… before each evaluation cycle" and the "When the loop says it is done" section) and `docs/ARCHITECTURE.md` line 119 still describe the gate as the evaluator's step; the approving evaluator will reconcile them, or the loop can as part of the fix.

```findings
[
  { "severity": "critical", "file": "src/server/orchestrator.ts", "line": 2041, "issue": "The sync acquires and releases the per-repo delivery lease (acquireRepoLeaseWithin/releaseRepoLease) instead of waiting for it to be free (waitForRepoLeaseRelease); two acceptance criteria fail and a delivery longer than 30s now fails the loop run." },
  { "severity": "important", "file": "specs/29-sync-and-gate-before-evaluation.md", "issue": "Decision 1 says the sync takes the delivery lease (task 7 wording) — must revert to waiting for it; decision 4 claims GATE.md is missing after a killed/unrunnable gate, but runLoop writes it in every gate outcome." },
  { "severity": "suggestion", "file": "src/server/orchestrator.ts", "issue": "Nothing checks that conflict markers are gone before the bookkeeping commit completes the merge; an ITERATION_DONE with markers left commits them as the resolution." },
  { "severity": "suggestion", "file": "docs/HOW_IT_WORKS.md", "issue": "Gate description (\"before each evaluation cycle\") and the \"When the loop says it is done\" section do not yet mention the base sync or that the gate now runs before DONE is accepted." }
]
```
