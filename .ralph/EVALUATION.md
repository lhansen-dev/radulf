VERDICT: approve

Feedback round 2. Both defects from the previous round are fixed and every
acceptance criterion passes when run here.

## What I verified

Criteria, each run by me in this worktree:

- `grep -n 'fs.mkdirSync(path.join(run2.worktree_path, "mock-output")' src/server/splitProcesses.test.ts`
  → line 868, between the `git rm` and the `contention-2.md` write. OK.
- `grep -n 'leaseHolder' src/server/integrity.ts` → 3 matches (import at line 7,
  doc + use in `waitForRepoLeaseRelease`, lines 219/223). OK.
- `grep -n 'waits for the repo lease holder' src/server/integrity.test.ts` → line 224. OK.
- `npx vitest run src/server/integrity.test.ts` → 13 passed, exit 0.
- `npx vitest run src/server/repoLeases.test.ts` → 8 passed, exit 0.
- `grep -n 'repository record vanished before delivery' src/server/reviewService.ts` → line 413. OK.
- `npx vitest run src/server/reviewService.test.ts src/server/reviewService.pr.test.ts` → 22 passed, exit 0.
- `grep -c 'in-process merge claim' src/server/orchestrator.ts` → prints `0`. OK
  (the stale comment was rewritten to describe the delivery row; the loop's
  claim in DONE that the check was "inverted" is wrong — the check wanted `0`,
  which is what it prints).
- `npx vitest run src/server/git.test.ts src/server/orchestrator.reaper.test.ts src/server/orchestrator.lifecycle.test.ts src/server/stage.test.ts src/db/schema.test.ts`
  → 151 passed, exit 0.
- `npx tsc --noEmit` → exit 0. `npx eslint` on the seven listed files → exit 0.
- `NODE_ENV=production node_modules/.bin/next build --webpack` → exit 0, then
  `RADULF_SPLIT_CHECK=1 npx vitest run src/server/splitProcesses.test.ts` → 9/9,
  exit 0 on two consecutive runs (and again on runs 4 and 5 of 5; see below).
  "two approvals from two web processes deliver serially and a loop overlapping
  a sibling merge reports no tampering" passed on all five runs.

Repository gate: `make lint typecheck build check-split` exit 2 is the Turbopack
`Symlink [project]/node_modules is invalid` panic named in the card's build note
(`node_modules -> /repos/radulf/node_modules`). Lint and typecheck passed inside
the gate before the build step; the webpack build and the split check pass when
run as the card instructs. Environmental, not evidence against the change.

Code review against the card:

- Web side (`reviewService.ts` `approveClaimedRun`): the card is moved to
  `reviewing` by `claimReviewRun` as before, then a `review_deliveries` row is
  inserted and `review.delivery_requested` emitted; a passive process returns
  immediately. `pump()` returns early when passive, so a web-only process never
  reaches `claimPendingDeliveries()` and never merges. `reject` touches no repo.
- Worker side: `claimDelivery` takes the `repo_leases` row and flips the row
  pending→running in one `immediate` transaction; `executeDelivery` runs the
  unchanged `deliver()` → `mergeBranch` / `deliverPullRequest` paths, records the
  base-branch move via `recordRefWrite` from `mergeBranch`'s `onCommitted`, and
  releases the lease in `finally`. Same-worker re-entry is refused, so two
  pending deliveries on one repo serialize within one worker too.
- Integrity (`integrity.ts`): `liveBaselines`/`registerRunBaseline`/
  `releaseRunBaseline`/`noteRadulfRefWrite` are gone from `src` (grep). The
  run-end check compares refs against `ref_writes` since `baseline.capturedAt`
  (captured before the ref snapshot, ISO strings on both sides), and on an
  unexplained move waits (≤30 s, 50 ms poll) for the repo lease to clear and
  re-reads `ref_writes` against the same snapshot — closes the `git commit` →
  `recordRefWrite` sliver that flaked last round. A write for another repo or
  one that predates the baseline still counts as a violation (unit-tested).
- Reaper (`orchestrator.ts` `reapStaleRuns`): `running` deliveries whose worker
  is not live are CAS-finished with ok=0, the card parked in Needs Attention
  with a reason, `review.decided` emitted, stale leases released; the orphan
  sweep leaves `reviewing` cards that own a pending/running delivery alone.
  Pending deliveries for a vanished repo are finished failed and parked instead
  of polled forever (last round's non-blocking note).
- `withRepoMergeLock` and `mergeBranchLocked` are removed; `mergeBranch` is the
  only caller site and documents that the caller must hold the lease. Migration
  `drizzle/0020_wonderful_martin_li.sql` creates the three tables with journal
  entry. No unrelated changes in the diff.

## For the human reviewer

- Split-run stability: five runs of the split file — four green, one failure
  (run 3) in the pre-existing "drives a card from Todo to In Review through the
  web-only process" test at `expect(pushes.length).toBeGreaterThan(0)` (live
  transcript frames reaching web2's stream). That path (events tailer /
  transcript watcher) is untouched by this diff and the new test was not the
  one that failed; I judge it a pre-existing timing flake in the fan-out test,
  but it is worth knowing the split gate is not perfectly deterministic.
- `ReviewService.abandon()` still calls `removeWorktree` (a `git worktree
  remove` + `branch -D` on the parent repo) in whatever process serves the API,
  including a web-only one. Outside this card's enumerated scope (approve /
  retry-merge / reject / delivery), and pre-existing, but it is the one
  remaining repo write reachable from a web-only process.
- In the single-process default the approve request still runs the merge
  inline (`awaitDelivery` claims and executes); in a web-only process the API
  returns 200 with the card in `reviewing` and the outcome arrives later via
  card status / `review.decided`. Clients that assumed "200 means merged" now
  see `reviewing` first.

```findings
[
  { "severity": "suggestion", "file": "src/server/reviewService.ts", "line": 264, "issue": "abandon() still runs removeWorktree (a parent-repo write) in the calling process, so a web-only process can still write to a repository via abandon; pre-existing and outside this card's approve/retry/reject scope, worth a follow-up card." },
  { "severity": "suggestion", "file": "src/server/orchestrator.ts", "line": 599, "issue": "If a worker dies after completeApproval moved the card to done but before the delivery row is finished, the reaper emits a spurious review.decided deliveryFailed event on a done card (the moveCard CAS fails harmlessly); consider checking the card status before emitting." },
  { "severity": "suggestion", "file": "src/server/splitProcesses.test.ts", "line": 498, "issue": "Pre-existing split test 'drives a card from Todo to In Review' failed once in five runs on pushes.length > 0 (transcript fan-out to web2); not touched by this card but the split gate is not fully deterministic." }
]
```
