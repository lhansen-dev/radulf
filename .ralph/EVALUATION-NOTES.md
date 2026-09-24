# Evaluator notes (attempt started 2026-09-24T01:53Z, HEAD 9e9bccb)
- grep AC1 (no activeLoopCards|pendingEvaluations|pausedCards in orchestrator.ts): PASS (exit 0 for negated grep)
- grep AC2 (claimLoopRun/claimPendingEvaluation/reapStaleRuns present): PASS
- grep AC4 (onConflictDoUpdate in workers.ts): PASS
- grep AC7 (orphans: true in orchestrator.ts): PASS
- grep AC8 (disposeAllOrchestrators exported + used in 4 suites): PASS
- grep AC9 (claimStage present, 3x behavior: "immediate"): PASS (count=3)
- git diff harness/sandbox vs merge-base beta: PASS (unchanged)
- Gate (make lint typecheck build check-split) per GATE.md: exit 0, split check 5/5 incl. cap contention + SIGKILL handover
- npx vitest run src/server/orchestrator.scoping.test.ts: PASS 13/13
- npx vitest run src/server/workers.test.ts -t "re-inserts": PASS 1 passed
- npx vitest run src/server/orchestrator.reaper.test.ts -t "continuous pass leaves a run-less reviewing card alone": PASS 1 passed
- npx vitest run src/server/orchestrator.claim.test.ts -t "claimStage": PASS 1 passed
- npx vitest run workers+claim+reaper+roles: PASS 29/29
- npx vitest run src/server/orchestrator.lifecycle.test.ts: PASS 98/98
- npx vitest run mockPipeline+stage+planningService+settings: PASS 35/35
- make lint typecheck: PASS exit 0
- make check-split: relying on GATE.md (exit 0, ran 01:52:40 on this HEAD, 5/5 incl. cap contention + SIGKILL handover) — not re-running per instructions
- Verdict written: approve (2 important findings: cancelCard leaves evaluation_pending set; boot orphan sweep idle filter in single-process). SUMMARY.md written.
- Approve: reconciled docs/ARCHITECTURE.md (recover/reaper/workers, pipelineLoad + BEGIN IMMEDIATE claims) and docs/TROUBLESHOOTING.md (new 'worker <id> stopped heartbeating' exit reason). No source edits.

# Attempt 2 started 2026-09-24T02:09:06Z, HEAD 9e9bccb; prior docs/ edits still in worktree (uncommitted)
- Attempt 2: grep ACs 1,2,4,7,8,9,14 re-run: all PASS (immediate count=3)
- Attempt 2: vitest scoping+workers+claim+reaper+roles: PASS 42/42 exit 0
- Attempt 2: -t 're-inserts' PASS 1; -t 'continuous pass leaves a run-less reviewing card alone' PASS 1; -t 'claimStage' PASS 1
- Attempt 2: lifecycle suite PASS 98/98 exit 0
- Attempt 2: mockPipeline+stage+planningService+settings PASS 35/35 exit 0
- Attempt 2: make lint typecheck PASS exit 0; make check-split: relying on gate (exit 0, 5/5 on this HEAD at 01:52)
- Attempt 2: reverted prior attempt's uncommitted docs/ edits (previous verdict was rejected for 'non-doc' path ocs/ARCHITECTURE.md); patch preserved in notes below. No doc edits this attempt.

## Verdict (attempt 2): approve — written 2026-09-24T02:17:28Z. SUMMARY.md written. Findings: 2 important (cancelCard evaluation_pending leak; boot orphan sweep idle filter in single-process), 3 suggestions.

## Docs reconciliation patch (NOT applied; previous attempt's docs/ edits were rejected by the path check)
```diff
diff --git a/docs/ARCHITECTURE.md b/docs/ARCHITECTURE.md
index 1a2fa37..8da5475 100644
--- a/docs/ARCHITECTURE.md
+++ b/docs/ARCHITECTURE.md
@@ -33,9 +33,20 @@ and from `src/worker.ts` (`make worker`) as a plain Node process. `RADULF_ROLES`
 (`web`, `worker`, default both) decides what runs. A web-only process serves
 the UI and API and only moves cards. A worker-only process ensures the auth
 secret, runs the sandbox preflight (once, cached), then recovery — `recover()`
-flips any run orphaned by a restart into Needs Attention — the queue pump
-(event-driven plus a short timer), the stages, improvement-run drivers,
-schedules, retention and the shutdown drain, and listens on no port.
+is the first pass of the stale reaper (below) plus a sweep of the per-run
+scratch directories no live worker owns — the queue pump (event-driven plus a
+short timer), the stages, improvement-run drivers, schedules, retention and
+the shutdown drain, and listens on no port.
+
+Every process, web or worker, registers a row in the `workers` table at boot
+and upserts its heartbeat on a fixed interval (spec 25). Each run row carries
+`runs.worker_id`, the worker that claimed it. On the same interval every
+worker runs `reapStaleRuns()`: a `running` run whose worker's heartbeat is
+older than the `workerStaleSeconds` setting (floor 15 s, read at reap time) is
+finished as interrupted with a compare-and-set, its open iteration is failed,
+its card returns to Ready when the loop is resumable and goes to Needs
+Attention otherwise, and the dead worker's row is deleted. A worker never
+reaps its own runs or those of a worker that is still heartbeating.
 
 ## The orchestrator
 
@@ -43,9 +54,20 @@ schedules, retention and the shutdown drain, and listens on no port.
 pipeline is a service it owns.
 
 `pump()` fills a repo's free pipeline slots. `pipelineLoad()` counts that
-repo's cards currently `planning`, `looping` or `evaluating`, and
+repo's cards currently `planning`, `looping` or `evaluating`, plus any card
+with a `running` run row (a loop still tearing down), and
 `concurrencyLimit()` is the `maxConcurrentCards` setting, held at 1 while the
-loop provider is local (spec 20). A `ready` card loops before any fresh `todo`
+loop provider is local (spec 20). Every worker pumps; the orchestrator keeps no
+in-memory record of what is starting. Taking a slot is one SQLite transaction
+opened with `BEGIN IMMEDIATE` — `claimLoopRun()` for ready → looping (it also
+inserts the run row), `claimStage()` for todo/needs_attention → planning or
+evaluating, and `claimPendingEvaluation()` for a card whose
+`cards.evaluation_pending` flag was set when install scripts were approved
+while the repo was at its cap — each re-reading the card's status and the
+repo's load inside the transaction, so two workers on one database cannot
+start the same card twice or overfill a repo. A pause is the card's own
+`paused` status, set at once; the loop closes its run at the next iteration
+boundary. A `ready` card loops before any fresh `todo`
 card is planned — in-flight work finishes ahead of new work. Backlog is never
 queried.
 
diff --git a/docs/TROUBLESHOOTING.md b/docs/TROUBLESHOOTING.md
index 0dbd247..f013e04 100644
--- a/docs/TROUBLESHOOTING.md
+++ b/docs/TROUBLESHOOTING.md
@@ -144,7 +144,17 @@ disk-limits section.
 
 **`server restarted mid-run`**
 Radulf was restarted while the run was in flight. The run is marked interrupted
-and the card returns to Needs Attention; restart it.
+and the card returns to Needs Attention; restart it. A loop whose worktree and
+plan checklist survived goes back to Ready instead and resumes from its first
+unchecked task.
+
+**`worker <id> stopped heartbeating`**
+The worker process that owned the run went longer than the *Worker stale
+window* setting (default 120 s, floor 15 s) without a heartbeat — it crashed,
+was killed, or stalled — and another worker reaped the run. Same outcome as a
+restart: a resumable loop returns to Ready and another worker picks it up;
+every other stage lands in Needs Attention. Widen the window on the Settings
+page if a healthy but very busy worker is being reaped.
 
 ## Approving a merge
 
```
