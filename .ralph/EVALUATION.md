VERDICT: approve

## What was verified

- **Cross-process fan-out (headline):** `make check-split` (which runs `make build` first — `check-split: build` in the Makefile) exits 0. All four tests in `src/server/splitProcesses.test.ts` pass: two web-only `next start` processes plus a worker-only `dist/worker.mjs` boot one fresh data dir; a card created through web 1 shows up as `card.created` on web 2's `/api/events/stream` (337 ms, well inside the 5 s window); the worker-executed loop run streams transcript pushes through web 2 that chain `fromCursor` from 0 with no gaps or duplicates and equal the chunked `/api/runs/:id?iteration=&cursor=` read from web 2, including a resume from the last pushed cursor; SIGTERM drains the worker.
- **Unit tests:** `npx vitest run src/server/eventsTail.test.ts src/server/transcriptWatchers.test.ts src/server/transcript.test.ts src/server/stage.test.ts src/server/scoping.test.ts src/server/boot.test.ts` → 6 files, 45 tests pass (tailer emits foreign rows once, never re-emits local rows, replays nothing pre-existing, writes nothing; one watcher per running run pushing each line once, none for a completed run, follows the latest iteration, bus-driven start/stop plus `runs` reconcile; `startTranscriptPush` late-attach catch-up).
- **Static gates:** `npx tsc --noEmit` exit 0; `npx eslint` on `eventsTail.ts transcriptWatchers.ts splitProcesses.test.ts boot.ts stage.ts` exit 0.
- **Greps:** `startEventsTail()` in `boot.ts` outside any role guard and `if (roles.has("web")) startTranscriptWatchers()` present; no `db.(insert|update|delete)` in `eventsTail.ts`; `startTranscriptPush` still in `scoping.ts`; no `clientId|watch` in the SSE route / `ui/api.ts` / `useRunActivity.ts` and no `*watch*` route under `src/app/api`; `src/app/layout.tsx` untouched and still on `next/font/google`; ARCHITECTURE.md names both new modules and both env vars; README has the new `check-split` row; spec 25 decision 5 carries the "no client-interest protocol" amendment.
- **Suite health:** the gate's `make check` failed only in the card's listed environmental files (harness stall tests, streamLiveness, srt real-runtime rows; first 12 of 21 failures truncated from the log). Running vitest with those four files excluded: 125 files / 1153 tests pass, and the one remaining failing file (`src/server/evaluationService.test.ts`, 3 tests: spec 26 timeout recovery ×2, spec 27 gate) fails identically on a `git archive beta` copy — pre-existing on beta, not this card.
- **Code review:** `emitEvent` records its ids in a globalThis-backed set; the tailer skips those and prunes the set past `lastId`, so single-process delivery is exactly once (ids are `autoIncrement` so no reuse). The watcher registry keys on run id, replaces a loop run's watcher on iteration change, stops on `run.finished`, and a periodic `runs` scan covers statuses that end without that event (recover(), cancel). `readTranscriptChunk`, the push payload shape and the browser are unchanged; `startTranscriptPush` gained a catch-up pump on attach and a `stopped` guard for reads that settle after `stop()`.

## Two acceptance greps do not hold literally, though their stated intent does

1. `grep -q 'startTranscriptPush' src/server/stage.ts` **succeeds** (criterion expects failure). The import and the call are gone — `runWithTranscript` just calls `runHarness` — but the loop's final commit (47564aa) added the identifier to the doc comment to satisfy a stale plan-level check. Behaviour is correct; the human reviewer may want to reword the comment (e.g. "does not start its own transcript push") so the proxy grep holds.
2. `grep -c 'spawnWeb(' src/server/splitProcesses.test.ts` prints **2**, not ≥3: the helper is `const spawnWeb = (p: number) =>` (no paren after the name) and there are two call sites. Two web-only processes are spawned, which is what the criterion is checking for.

I am treating both as proxy mismatches rather than criterion failures because the parenthetical requirement of each is met and the split check proves the behaviour end to end.

## For the human reviewer

- The split test pins `RADULF_EVENTS_TAIL_INTERVAL_MS=50` / `RADULF_TRANSCRIPT_SCAN_INTERVAL_MS=100` (the floors) because the mock provider finishes a loop run in a few hundred ms; production defaults are 500 ms / 5 s.
- `stopped` in `startTranscriptPush` now drops a read that settles after `stop()`. The browser already refetches from its cursor when a run leaves `live`, so the tail of a finished iteration still arrives — but live pushes may now end a chunk earlier than before.

```findings
[
  { "severity": "important", "file": "src/server/stage.ts", "line": 98, "issue": "Doc comment names `startTranscriptPush`, so the acceptance grep `grep -q 'startTranscriptPush' src/server/stage.ts` succeeds where the criterion expects it to fail; the call and import are gone, so only the comment wording needs to change." },
  { "severity": "suggestion", "file": "src/server/splitProcesses.test.ts", "line": 201, "issue": "`grep -c 'spawnWeb('` prints 2 (arrow-function helper plus two call sites) against the criterion's expected ≥3; behaviour is fine, the helper could be a `function spawnWeb(` declaration to match." },
  { "severity": "suggestion", "file": "src/server/transcript.ts", "line": 188, "issue": "The new `if (chunk.hasMore) recheckPending = true` re-pumps without advancing `cursor` when a chunk consumed bytes but yielded zero lines (whitespace-only line), which would spin; harness writers never emit such lines, so theoretical." },
  { "severity": "suggestion", "file": "src/server/stage.ts", "line": 113, "issue": "`iteration: _iteration; void _iteration;` keeps a now-unused parameter alive; dropping `iteration` from the signature and its three callers would be cleaner." }
]
```
