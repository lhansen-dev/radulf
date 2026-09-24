VERDICT: revise

The implementation is substantially complete and well-tested — the critic stage, settings, schema/migration, mock scripts, UI, and the planning hand-off all work, and 12 of 14 criteria pass. Two criteria fail, one of them a real `make check` regression, and one functional gap makes critic transcripts unviewable. All three fixes are small and precisely located.

## What fails

### 1. Spec 30 must not mention the number 28 (acceptance criterion)

```
$ grep -c '28' specs/30-plan-critic.md
2
$ grep -n '28' specs/30-plan-critic.md
5:Numbered 30 because 28 (epic pieces declare dependencies, scheduled as a
9:spec 28 or spec 24 picked for it, and changes nothing about when the piece
```

Expected `0`. The last loop commit (5853d65, "task 11") added a six-line "Numbered 30 because 28 … and 29 …" paragraph to `specs/30-plan-critic.md` lines 5–10. **Delete that whole paragraph** (from "Numbered 30 because…" through "…is started.") so the file's header is only the two-line "Decided 2026-09-24. Extends … amends nothing else." sentence. Do not reference spec 28 or spec 29 anywhere in the file, and keep the `# 30: A plan critic` heading and the `docs/DESIGN_HISTORY.md` row as they are. Verify with `grep -c '28' specs/30-plan-critic.md` printing `0`.

### 2. `make check` fails: `requestValidation.test.ts` regression (acceptance criterion)

```
$ npx vitest run src/server/requestValidation.test.ts
 FAIL  src/server/requestValidation.test.ts > card request validation > normalizes a valid create request
AssertionError: expected { Object (repoId, title, ...) } to deeply equal { Object (repoId, title, ...) }
+   "criticModel": null,
+   "planCritic": undefined,
 ❯ src/server/requestValidation.test.ts:156:7
 Tests  1 failed | 32 passed (33)
```

This passes at the merge base and fails deterministically on HEAD: `parseCreateCard` in `src/server/cardValidation.ts` now always returns `criticModel: null` (via `optionalString`) and `planCritic: undefined`, but the expected object in `src/server/requestValidation.test.ts` (the `toEqual({...})` starting at line 156) was never updated. **Add `criticModel: null` to that expected object** (the `planCritic: undefined` key is ignored by `toEqual`, but adding `planCritic: undefined` too is fine). Re-run `npx vitest run src/server/requestValidation.test.ts` and confirm 33/33.

### 3. Critic transcripts cannot be opened from the UI (card: "a transcript like every other run")

`src/app/api/runs/[id]/route.ts` (~line 33) maps single-transcript run kinds to files:

```ts
const singleFile: Partial<Record<typeof run.kind, string>> = {
  plan: "plan.jsonl",
  evaluate: "evaluate.jsonl",
};
```

`critique` is missing. The runs table (`src/app/card/[id]/runsTable.tsx`) falls a critique run through the evaluate branch and its transcript button calls `open(0)` → `GET /api/runs/<id>?iteration=0` → the route treats it as a loop run and returns `iteration must be a positive integer`. The file `critique.jsonl` is written (verified in the mock pipeline test) but is unreachable from the UI, both for the historical load and the post-reconnect resync. **Add `critique: "critique.jsonl"` to `singleFile`** and, ideally, add a route test or a line in `src/server/transcriptWatchers.test.ts`-style coverage that fetches a critique run with `iteration=0`.

## Should also fix while re-planning (not disqualifying alone)

- `src/server/stageDiagnosis.ts:92` — `diagnosisMessage` maps every non-plan/non-loop kind to "evaluator", so three consecutive critic failures on one model produce the advisory "The evaluator has failed 3 times in a row…". Add a `critique` → "plan critic" branch.

## Verified OK (do not redo)

- All other grep criteria pass (heading, DESIGN_HISTORY row, `critique.md` naming `CRITIQUE.md`, settings keys, schema `"critique"` + `plan_critic`, `drizzle/0022_greedy_the_professor.sql`, `class PlanCriticService` + `parseEvaluation`, `critique.jsonl` in both files, `"critic"` + `critic-revise-once` in mock.ts, only `mock.ts` changed under `src/server/harness/`, settings page + newTaskDialog + cardValidation mention the critic).
- `npx vitest run` exits 0 for: `settings.test.ts` (7), `planCriticService.test.ts` (13), `planningService.test.ts` (20), `cardValidation.test.ts` + `transcriptWatchers.test.ts` (13), `mockPipeline.test.ts -t critic` (2: approve path and revise-once path), `src/app/settings/page.test.tsx` (12).
- `tsc --noEmit` and `eslint` exit 0; repository gate (lint/typecheck/build/check-split) exit 0.
- Full suite run once: the remaining failures are the environmental ones the card lists (bookkeeping, harness/index watchdog+stall, streamLiveness, srt) plus `src/server/evaluationService.test.ts` (3 spec 26/27 timeout tests), which fails identically at the merge base 620e94e and is therefore pre-existing, not this card's. `src/app/settings/page.test.tsx` had two 5 s timeouts only under full-suite load and passes alone.
- Code review: read-only enforcement (HEAD unchanged, `git status` diff filtered to `.ralph/CRITIQUE.md`), verdict parsed by the shared `parseEvaluation`, approve → `planningDestination(card)`, revise → run feedback + `replan`, third consecutive revise → `plan_review`, `pendingReplanFeedback` prefixes critique feedback, breakdown pieces inherit `planCritic`/`criticModel`, `retryFailedStep` handles `critique`, `harnessFailure`/`renderDeadlineSection` widened for the critic.

```findings
[
  { "severity": "critical", "file": "specs/30-plan-critic.md", "line": 5, "issue": "Spec mentions the number 28 twice (numbering paragraph added in task 11); acceptance criterion requires `grep -c '28'` to print 0 — delete the paragraph." },
  { "severity": "critical", "file": "src/server/requestValidation.test.ts", "line": 156, "issue": "`normalizes a valid create request` fails on HEAD (passes at merge base): expected object lacks the `criticModel: null` that parseCreateCard now returns, so `make check` fails." },
  { "severity": "important", "file": "src/app/api/runs/[id]/route.ts", "line": 33, "issue": "`singleFile` map lacks `critique: \"critique.jsonl\"`, so the UI's transcript request `?iteration=0` for a critique run is rejected with `iteration must be a positive integer` and critic transcripts cannot be viewed." },
  { "severity": "important", "file": "src/server/stageDiagnosis.ts", "line": 92, "issue": "diagnosisMessage labels a `critique` run's failure streak as \"evaluator\"; add a plan-critic branch." },
  { "severity": "suggestion", "file": "src/server/cardTransfer.ts", "issue": "Card export/import does not carry the new `planCritic`/`criticModel` columns, so the per-card override is lost on round-trip." },
  { "severity": "suggestion", "file": "src/server/planCriticService.ts", "line": 119, "issue": "consecutiveCriticRevisions is reset only by a loop run, so after a human plan-review rejection and re-plan the critic's first new revise escalates straight to plan_review (prior count is already 2)." },
  { "severity": "suggestion", "file": "src/app/card/[id]/runsTable.tsx", "line": 321, "issue": "A critique run falls through to the evaluate branch and shows the card's evaluator Summary beneath its verdict; a dedicated critique branch (verdict + feedback) would be clearer." }
]
```
