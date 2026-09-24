VERDICT: approve

## What was verified (HEAD 9e9bccb)

Every acceptance criterion was run in this attempt (except `make check-split`, which the
repository gate ran on this exact HEAD at 01:52 — exit 0, 5/5 including "two workers never
run two runs of one repo at once with a cap of one" and "SIGKILL on a worker mid-loop hands
the card to the other worker within the stale window"; I did not re-run it per instructions).

| Criterion | Result |
|---|---|
| no `activeLoopCards`/`pendingEvaluations`/`pausedCards` in orchestrator.ts | PASS |
| `claimLoopRun`, `claimPendingEvaluation`, `reapStaleRuns` present | PASS |
| `orchestrator.scoping.test.ts` | PASS 13/13 |
| `onConflictDoUpdate` in workers.ts | PASS |
| `workers.test.ts -t "re-inserts"` | PASS 1 |
| `orchestrator.reaper.test.ts` (7/7) and `-t "continuous pass leaves a run-less reviewing card alone"` | PASS, 1 passed |
| `orphans: true` in orchestrator.ts (boot-only orphan sweep) | PASS |
| `disposeAllOrchestrators` exported + used in lifecycle/claim/reaper/roles suites | PASS |
| `claimStage` present, `behavior: "immediate"` ×3 | PASS (count = 3) |
| `orchestrator.claim.test.ts -t "claimStage"` | PASS 1 |
| workers + claim + reaper + roles suites | PASS 29/29 (42/42 with scoping) |
| `orchestrator.lifecycle.test.ts` | PASS 98/98 |
| mockPipeline + stage + planningService + settings | PASS 35/35 |
| `git diff --quiet <merge-base> -- src/server/harness src/server/sandbox` | PASS (unchanged) |
| `make lint typecheck` | PASS exit 0 |
| `make check-split` | PASS via gate (exit 0, 5/5) |

Code read end to end: `workers.ts`, the `workers` table / `runs.worker_id` /
`cards.evaluation_pending` schema and migration 0018, `claimLoopRun`, `claimStage`,
`claimPendingEvaluation`, `loadFor` under the transaction handle, `pump()`, `reapStaleRuns`
(CAS on `status = running`, own runs never reaped, dead worker rows deleted, stale window read
per call), `recover()` (reaper first pass + live-run-aware scratch sweep), `parkOrResume`,
`isRunActive`, pause/resume as card status, `approveInstallScripts`, `startCard`,
`retryFailedStep`, `workerStaleSeconds` (default 120, floor 15, validated via
`INTEGER_SETTINGS`, exposed on the settings page), and the split test's cap-contention and
SIGKILL assertions (disjoint run intervals, interrupted victim, finisher on the other worker,
2–3 iterations total, both task outputs in the finisher's worktree, dead worker row gone).

## For the human reviewer

Two narrow, real bugs that the criteria do not cover — worth a small follow-up, not
disqualifying:

1. **`cancelCard()` (src/server/orchestrator.ts ~1078) does not clear `cards.evaluation_pending`.**
   It writes `status: "backlog"` directly instead of through `moveCard`, so a card whose
   evaluation was queued behind the cap and was then pulled to Backlog keeps the flag. The next
   time that card lands in `needs_attention` for any reason, `pump()` auto-claims it into
   `evaluating`, skipping the human gate. Fix: add `evaluationPending: 0` to the `set({...})` in
   `cancelCard` (and the bare fallback in `src/app/api/restart/route.ts:60` for the same reason).

2. **Boot orphan sweep in `reapStaleRuns({ orphans: true })` only parks run-less cards whose
   `updatedAt` is older than the stale window.** That filter is right when a live peer might be
   mid-start, but in the single-process default a crash in the few-second window between
   `claimStage` (card → planning/evaluating) and `startRunRow`, followed by a restart within
   120 s, leaves the card in `planning` with no run and nothing ever parks it (the continuous
   pass does not sweep orphans). Beta's `recover()` parked these unconditionally. Suggested fix:
   drop the idle filter when `liveWorkerIds()` contains no worker other than this one.

Suggestions (no action required): the cap-contention split test verifies from the runs table
only, not from `card.moved` events as the card's first criterion phrases it; the finisher's
worktree is checked for both task outputs but not asserted equal to the victim's
`worktree_path`; `hasInFlightWork()` still counts every card in a running status globally, so
a draining worker waits (up to the 30 s shutdown timeout) on a peer's card — "drain unchanged"
per the card, but worth knowing with two workers.

**Docs not reconciled in this attempt.** The previous evaluator attempt's edits to
`docs/ARCHITECTURE.md` (recover/reaper/workers table, `BEGIN IMMEDIATE` claims) and
`docs/TROUBLESHOOTING.md` (new `worker <id> stopped heartbeating` exit reason) were rejected by
the post-run path check as "non-doc files", so I reverted them to HEAD and made no doc edits.
`docs/ARCHITECTURE.md` ("recover() flips any run orphaned by a restart into Needs Attention")
and `docs/TROUBLESHOOTING.md` (no entry for the new exit reason) are now slightly stale; the
ready-to-apply patch is recorded in `.ralph/EVALUATION-NOTES.md`. `specs/02-architecture.md`
was updated by the change itself.

```findings
[
  { "severity": "important", "file": "src/server/orchestrator.ts", "line": 1084, "issue": "cancelCard() writes status=backlog directly and leaves cards.evaluation_pending set, so a cancelled queued-evaluation card is auto-claimed into evaluating the next time it reaches needs_attention (also the bare fallback in src/app/api/restart/route.ts:60)." },
  { "severity": "important", "file": "src/server/orchestrator.ts", "line": 526, "issue": "Boot orphan sweep only parks run-less planning/evaluating cards idle past the stale window; in the single-process default a crash between claimStage and startRunRow plus a restart within 120s leaves the card stuck in planning holding the repo slot (beta recover() parked these unconditionally)." },
  { "severity": "suggestion", "file": "src/server/splitProcesses.test.ts", "line": 448, "issue": "Cap-contention scenario verifies disjoint intervals from the runs table only; the card's criterion also names the events, and the SIGKILL scenario could assert finisher.worktree_path === interrupted.worktree_path." },
  { "severity": "suggestion", "file": "src/server/orchestrator.ts", "line": 1146, "issue": "hasInFlightWork() counts every card in a running status regardless of owner, so a draining worker waits up to the shutdown timeout on a peer's card; scoping it to this worker's runs would make drain multi-worker aware." },
  { "severity": "suggestion", "file": "docs/ARCHITECTURE.md", "line": 36, "issue": "Process/orchestrator prose still describes recover() as flipping orphaned runs to Needs Attention and does not mention the workers table, heartbeats, or the BEGIN IMMEDIATE claims; docs/TROUBLESHOOTING.md lacks the new 'worker <id> stopped heartbeating' exit reason (patch in .ralph/EVALUATION-NOTES.md)." }
]
```
