VERDICT: revise

The implementation is substantially right — schema, migration, `ref_writes`-based
integrity check, `repoLeases.ts`, the web-side enqueue / worker-side claim split in
`reviewService.ts`, and the delivery reaper all exist and their unit tests pass
(schema, integrity, repoLeases, git, reviewService, reviewService.pr,
orchestrator.reaper, orchestrator.lifecycle, stage: all green; `tsc --noEmit` and
`eslint` exit 0). The last acceptance criterion fails, though, and it fails for a
reason the loop never saw because it never ran the split check (commit fedfb90:
"tsc + skipped vitest run pass").

## What fails

### 1. The new split-process test is broken deterministically (critical)

`make build` cannot run in this sandbox (Turbopack: "Symlink [project]/node_modules
is invalid, it points out of the filesystem root" — environmental, node_modules is a
symlink to /repos/radulf/node_modules). I built with
`NODE_ENV=production node_modules/.bin/next build --webpack` (20 s, OK) and ran

```
RADULF_SPLIT_CHECK=1 npx vitest run src/server/splitProcesses.test.ts
```

Result: 8 passed, 1 failed, exit 1:

```
 × two approvals from two web processes deliver serially and a loop overlapping a sibling merge reports no tampering 14ms
Error: ENOENT: no such file or directory, open '/tmp/claude/radulf-split-3KbxgO/worktrees/contention-2-Jpc4ERE1aVD-5gI2-ZGpa/mock-output/contention-2.md'
 ❯ src/server/splitProcesses.test.ts:863:10
    862|       git2("rm", "-q", "mock-output/task-1.md", "mock-output/task-2.md");
    863|       fs.writeFileSync(
```

Cause: the mock loop writes exactly two files, `mock-output/task-1.md` and
`task-2.md` (`src/server/harness/mock.ts:87`). `git rm` of both empties
`mock-output/` and git deletes the now-empty directory, so the following
`fs.writeFileSync(path.join(run2.worktree_path, "mock-output", "contention-2.md"))`
has no parent directory. This fails every time.

Fix in `src/server/splitProcesses.test.ts` (around line 862): add
`fs.mkdirSync(path.join(run2.worktree_path, "mock-output"), { recursive: true });`
between the `git rm` and the `fs.writeFileSync`, or write `contention-2.md` and
`git add` it before the `git rm`. Then actually run the test with
`RADULF_SPLIT_CHECK=1` — do not stop at the skipped run.

### 2. With that fixed, the test is flaky on exactly the thing it asserts (critical)

I applied the one-line mkdir fix in a scratch copy of the worktree (under `$TMPDIR`,
not in the repo) and ran the full split file eight times: six passes, two failures,
both:

```
Error: overlapping card landed in needs_attention
```

Events captured for the failing card on the second failure:

```
run.finished (kind evaluate): {"status":"failed","exitReason":"repo integrity violation: ref moved: refs/heads/main (8e2fa396748f → a38eabce8f27)"}
card.moved: {"from":"evaluating","to":"needs_attention","reason":"repo integrity violation: ref moved: refs/heads/main (8e2fa396748f → a38eabce8f27)"}
```

That is precisely the false positive the card exists to remove ("A loop running
against a repo while a sibling card's approval merges into that repo's base branch
does not report an integrity violation at its run end ... across a worker pair").
The race: in `checkRepoIntegrity` (`src/server/integrity.ts`, `checkRefs` branch)
`snapshotRefs()` runs first and `refWritesSince()` second. If a sibling worker's
`mergeBranch` has already moved `main` at `git commit` but has not yet reached
`onCommitted → recordRefWrite` (`git rev-parse HEAD` in between, plus the insert),
the check sees the new oid with no matching `ref_writes` row and reports tampering.
The same sliver existed on beta with `noteRadulfRefWrite` (the comment in
`git.ts` `mergeBranch` acknowledges it), but the lease table now makes it closable,
and the new gate test trips over it roughly one run in four here.

Suggested fix, in `src/server/integrity.ts` `checkRepoIntegrity` when
`opts.checkRefs` is set: before `snapshotRefs()`, wait (bounded, e.g. up to a few
seconds, polling) while `leaseHolder(repoPath)` (from `./repoLeases`) names a live
worker — every delivery records its ref write *before* `executeDelivery`'s
`finally` releases the lease, so once the lease is free every write is visible;
then snapshot refs and query `ref_writes`. A cheaper alternative: when a
non-managed ref is found moved/appeared with no matching write, re-query
`refWritesSince` once after a short grace (~1 s) before recording the violation.
Either way, add an integrity unit test for "write recorded after refs were read"
and re-run the split file several times to confirm it is stable.

## Acceptance criteria — results

- Schema greps: `grep -q 'sqliteTable("review_deliveries"'` literally FAILS because
  prettier wrapped `sqliteTable(\n  "review_deliveries",` (same for `ref_writes`);
  all three tables are defined in `src/db/schema.ts` — formatting artefact, not a
  defect. `repo_leases` matches.
- Migration `drizzle/0020_wonderful_martin_li.sql` has `CREATE TABLE ref_writes`;
  journal has 21 tags for 20 previous `.sql` files. OK.
- `vitest run src/db/schema.test.ts` OK. `integrity.test.ts` OK (spec 20 test rewritten
  against `ref_writes`, older write still a violation). `repoLeases.test.ts` OK.
  `git.test.ts` OK and `withRepoMergeLock` gone. `liveBaselines|registerRunBaseline|
  releaseRunBaseline|noteRadulfRefWrite` gone from `src`. `recordRefWrite` +
  `capturedAt` present.
- `reviewService.test.ts` + `reviewService.pr.test.ts` OK (finished row + lease
  release + ref write; passive path leaves `reviewing` with a pending row and no
  merge call; `claimPendingDeliveries` finishes it). `orchestrator.reaper.test.ts` OK
  (dead-worker delivery → finished ok=0, lease deleted, card `needs_attention`;
  live worker untouched; pending delivery skipped by orphan sweep).
  `orchestrator.lifecycle.test.ts`, `stage.test.ts` OK.
- `evaluationService.test.ts`: 3 failures (two spec 26 timeout tests, one spec 27
  gate test) — identical failures on `beta` (ran `git archive beta` in `$TMPDIR`),
  pre-existing and unrelated to this card.
- `tsc --noEmit` exit 0, `eslint` exit 0, `grep 'two approvals from two web processes'`
  OK.
- Split check: FAILS (above). Repository gate `make lint typecheck build check-split`
  exit 2 is the environmental Turbopack symlink failure, not evidence against the
  change.

## Other observations (not blocking)

- `ReviewService.claimDelivery` returns false when `getRepo(row.repoId)` is missing,
  so `awaitDelivery` in a non-passive process polls forever and a pending row for a
  deleted repo is never claimed (and its `reviewing` card is skipped by the orphan
  sweep). Consider finishing the row with `ok = 0` and parking the card instead.
- The new split test depends on the "Contention 1/2" cards created by the preceding
  "cap of one" test (running it with `-t` alone fails at line 842). Consistent with
  the file's style, but worth a comment.
- `Orchestrator.reapStaleRuns` orphan-sweep comment still says "a reviewing card lost
  the in-process merge claim"; the in-process claim no longer exists.

```findings
[
  { "severity": "critical", "file": "src/server/splitProcesses.test.ts", "line": 863, "issue": "New split test fails deterministically: `git rm` of both mock-output files deletes the empty directory, so the following fs.writeFileSync(mock-output/contention-2.md) throws ENOENT; the loop never ran the test (RADULF_SPLIT_CHECK=1)." },
  { "severity": "critical", "file": "src/server/integrity.ts", "issue": "Across a worker pair the overlapping evaluate run intermittently (2/8 runs) fails with 'repo integrity violation: ref moved: refs/heads/main' because checkRepoIntegrity reads refs after the sibling worker's `git commit` moved main but queries ref_writes before that worker's recordRefWrite ran; wait on the repo lease (or re-check ref_writes once) before declaring a non-managed ref move a violation." },
  { "severity": "suggestion", "file": "src/server/reviewService.ts", "issue": "claimDelivery returns false when the repo row is gone, so awaitDelivery polls forever and the pending row/reviewing card are never finished or parked." },
  { "severity": "suggestion", "file": "src/server/orchestrator.ts", "line": 623, "issue": "Orphan-sweep comment still refers to the removed in-process merge claim." },
  { "severity": "suggestion", "file": "src/db/schema.ts", "issue": "Criterion grep for `sqliteTable(\"review_deliveries\"` fails only because prettier wrapped the call across lines; tables exist." }
]
```
