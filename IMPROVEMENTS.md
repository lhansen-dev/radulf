# Low-effort repository improvements

Reviewed on 2026-09-11 at commit `a22e74e`. These recommendations come from
tracing the current code and running isolated reproduction probes. Effort
estimates include implementation and focused regression tests for one developer;
none requires a new dependency or database migration.

| Priority | Improvement | Impact | Estimated effort |
| --- | --- | --- | --- |
| 1 | Preserve unfinished cards' worktrees during history cleanup | High: prevents loss of pending work | 2–4 hours |
| 2 | Exclude runtime worktrees from Vitest and ESLint | Medium–high: keeps local checks reliable as work accumulates | 30–60 minutes |
| 3 | Reject repository deletion while work is active | High: preserves control and records for running jobs | 2–4 hours |
| 4 | Refresh board and card data after an event-stream reconnect | Medium: prevents stale task status and missed review prompts | 1–2 hours |

**1. Preserve unfinished cards' worktrees during history cleanup**

[pruneRuntimeHistory](src/server/retention.ts#L34) selects runs solely by an
old `endedAt`, then recursively removes every selected run's `worktreePath`.
An ended run does not mean its card is finished: planning, looping, and
evaluation [reuse the same worktree](src/server/orchestrator.ts#L590), and a
card can wait in Review or Needs Attention beyond the retention window.

Two probes reproduced the problem with a 30-day cutoff: an old completed
evaluation lost its worktree while its card remained in `review`; an old plan
and a currently running loop shared a directory, and cleanup removed that
directory while retaining the running loop's database row. The latter can
interrupt ongoing work; the former removes the checkout needed to review or
resume it. Uncommitted files are lost, even if committed changes remain
recoverable from the Git branch.

The small fix is to restrict run pruning to cards in `done` or `abandoned`,
then remove a directory only when no retained run references it. Preserve the
run records for unfinished cards as well as their directories:
[latestWorktreeRun](src/server/orchestrator.ts#L282) uses those records to find
the checkout on resume.

Extend the existing retention tests in
[orchestrator.lifecycle.test.ts](src/server/orchestrator.lifecycle.test.ts#L1345)
with an aged review card and an aged plan sharing a worktree with a live loop.
Assert that both retain their files and required run records, while an old
terminal card with an unshared directory is still cleaned up.

**2. Exclude runtime worktrees from Vitest and ESLint**

The default [WORKTREES_DIR](src/db/index.ts#L16) is now `./worktrees`, beside
`data`. However, [Vitest's exclusions](vitest.config.ts#L10) and
[ESLint's global ignores](eslint.config.mjs#L9) still cover only the old
`data/**` location for runtime files. The comments in both configurations
incorrectly imply that worktrees are already excluded.

A temporary test under `worktrees/` appeared in Vitest's actual test discovery.
ESLint's `isPathIgnored` returned `false` for a TypeScript file there and `true`
for the equivalent path under `data/`. Consequently, `make check` can execute
or lint code from active and retained agent checkouts. Self-improvement
worktrees contain copies of this suite, so checks can duplicate work and fail
on unrelated, unfinished changes. This is a confirmed discovery problem;
the runtime cost will depend on how many checkouts exist.

Add `worktrees/**`, `plans/**`, and `runtmp/**` to both exclusion lists, retaining
`data/**` for legacy paths. Update the comments to match the current directory
layout. TypeScript already limits its inputs to named source/configuration
paths, so its scope does not need broadening for this fix.

Validate with a disposable test and lint violation under `worktrees/`: neither
should be discovered by the root checks. Confirm that application tests and
`benchmarks/run-benchmark.test.mjs` still run, then run `make check`.

**3. Reject repository deletion while work is active**

[DELETE /api/repos/[id]](src/app/api/repos/[id]/route.ts#L44) immediately deletes
the repository row. Foreign keys then cascade through
[cards](src/db/schema.ts#L54), [runs](src/db/schema.ts#L122), and their related
records. The route does not check for active work or invoke cancellation.
By comparison, [card deletion](src/app/api/cards/[id]/route.ts#L102) explicitly
rejects active pipeline states.

An isolated route probe with a `looping` card and a `running` run returned
HTTP 200, removed both records, and left the worktree on disk. A real harness
could therefore continue after its card and controls disappear: cancellation
requires an explicit [controller abort](src/server/orchestrator.ts#L381), which
this route never performs. The probe verified the database/filesystem behavior;
it did not launch a paid provider session.

Add a repository-scoped busy check before deletion. Cover active pipeline
work, loop teardown, the `reviewing` merge claim, and running improvement runs
(including the interval before they create a card). The existing
[pipelineBusy](src/server/orchestrator.ts#L499) logic is a useful starting point
for a public service guard. Return an actionable conflict response and surface
it in the Settings repository list. Keep the guard and database deletion
together without an intervening asynchronous operation.

Test that active and reviewing repositories return a conflict without deleting
records, that a proposing improvement run also blocks removal, and that an idle
repository can still be removed. This keeps the initial patch focused on
preventing deletion during live work.

**4. Refresh board and card data after an event-stream reconnect**

The [SSE route](src/app/api/events/stream/route.ts#L7) sends live events without
replaying events missed during a disconnect.
[useEventStream](src/app/ui/api.ts#L100) reports connection changes, but
[useWorkData](src/app/ui/useWorkData.ts#L147) only updates `streamConnected` on
reconnection. Its 30-second timer clones the existing cards and checks health;
it does not fetch current cards. The browser's `online` handler does refetch,
but a server restart or dropped SSE connection need not trigger that browser
event. [useCardDetail](src/app/card/[id]/useCardDetail.ts#L89) also lacks a
reconnect refresh.

A hook probe simulated `onerror` followed by `onopen`: the board returned to
connected status with zero API fetches. A task that finishes during this gap
can remain displayed as running until another relevant event or a manual
refresh occurs.

Reuse the reconnect pattern already present in the
[transcript view](src/app/card/[id]/page.tsx#L708): remember a disconnect and call
the existing `refetch` after reconnection. Apply it to the board and card-detail
data, avoiding a duplicate fetch on the initial connection. This requires only
small hook changes and existing endpoints.

Extend [useWorkData.test.tsx](src/app/ui/useWorkData.test.tsx) to disconnect,
change the mocked server state, reconnect without a browser `online` event,
and verify the new card status appears. Add the equivalent card-detail case
and check that the initial connection does not duplicate loading.

Validation of this review: five temporary probes confirmed the cleanup,
repository-deletion, ESLint, and reconnect behaviors; a separate Vitest
discovery command confirmed the worktree test was included. The probes used
temporary data and were removed after execution. Project tooling was invoked
through `make`.

`make check` stopped at the test stage: **808 passed, 1 failed**. The existing
test "marks checklist item, removes signal, and commits with deterministic
message" in [orchestrator.test.ts](src/server/orchestrator.test.ts#L365) failed
because both Git HEAD reads returned the same invalid-HEAD error, rather than
different commit hashes. The same test failed when rerun alone. Separately,
`make lint typecheck build` passed; the build reported dynamic filesystem tracing
warnings. The only retained repository change is this report.
