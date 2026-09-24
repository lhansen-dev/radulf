VERDICT: approve

The plan critic stage is complete and every acceptance criterion passes. The three items from the previous revise (spec 30's "28" paragraph, the `requestValidation.test.ts` regression, the unreachable `critique.jsonl` transcript) and the "should also fix" item (stage diagnosis naming the evaluator for critic failures) are all resolved, each with a test.

## Verified

- Spec 30: `grep -c '28'` → `0` (exit 1); `grep -c '^# 30: '` → `1`; `Decided 2026-09-24` and `amends nothing else` both present; `docs/DESIGN_HISTORY.md` has the `30-plan-critic.md` row.
- `npx vitest run src/server/requestValidation.test.ts` → 33/33, exit 0; `criticModel: null` is in the expected object.
- `src/app/api/runs/[id]/route.ts` maps `critique: "critique.jsonl"`; `runRoute.test.ts` → 2/2 (critique with `iteration=0` → 200 with the transcript lines; loop with `iteration=0` still 400).
- `src/server/stageDiagnosis.ts` names `"plan critic"` for `critique` runs; `stageDiagnosis.test.ts` → 9/9.
- `planCriticService.test.ts` + `planningService.test.ts` → 33/33 (approve → ready / plan_review, revise → feedback on the run + `replan` without moving the card, 2 prior revisions → `plan_review`, non-verdict write → rejected to needs_attention, malformed verdict → needs_attention, planning hands off to `critique()` instead of moving the card, `pendingReplanFeedback` prefixes critic feedback with "The plan critic reviewed…").
- `mockPipeline.test.ts -t critic` → 2/2: `critic approve` (one `critique` run, `promptTokens > 0`, `critique.jsonl` on disk, one `critique.decided` event, card reaches review) and `critic-revise-once` (`["revise","approve"]`, two plan runs, v2 plan feedback contains "Mock critique").
- `settings.test.ts` + `cardValidation.test.ts` → 23/23.
- Only `src/server/harness/mock.ts` changed under `src/server/harness/` relative to `beta`.
- `npx tsc --noEmit` → exit 0; `npx eslint` on the four named files → exit 0.
- `make check`: the gate ran `lint typecheck build check-split` → exit 0 (41s); I ran `vitest run` for the `test` target → 140 files passed, 1 skipped (`splitProcesses`, covered by the gate), 1361 tests, exit 0 in 14s. None of the card's listed environmental failures occurred in this run, and `evaluationService.test.ts` passed 23/24 (1 skipped).
- Code review: `runCritic` mirrors the evaluator — HEAD and `git status --porcelain` before/after, stale `CRITIQUE.md` removed before the run, `parseEvaluation` reused, verdict recovered after a watchdog kill (spec 26 d4), `illegal` = new changed paths other than `.ralph/CRITIQUE.md`; approve → `planningDestination(card)`; revise cap counted only since the latest loop run; orchestrator's `retryFailedStep` retries a failed critique in place; breakdown pieces inherit `planCritic`/`criticModel`; migration `0023` chains on `0022` (`prevId` matches). Docs (ARCHITECTURE, HOW_IT_WORKS, PROVIDERS, spec 03/04, DESIGN_HISTORY) were updated by the change; I reconciled the two remaining "four roles" mentions in `docs/ARCHITECTURE.md` and `docs/PROVIDERS.md`.

## Criterion wording that misfires on this branch (intent passes)

- `git diff --name-only $(git merge-base HEAD origin/main …) -- src/server/harness/ | grep -v mock.ts | wc -l` prints `18`, but this branch is off `beta`, and all 18 files are beta-vs-main drift (the same 18 appear for `beta` itself against `main`). Against `beta` only `mock.ts` changed.
- `npx vitest run 'src/app/api/runs/\[id\]/runRoute.test.ts'` with the literal backslash escapes makes vitest look for `[id/]` and report "No test files found"; the unescaped path runs the file and passes 2/2.

## For the human reviewer

- The critic's verdict file is deleted from the worktree after it is read (nothing is committed); the record is the run row's `feedback`/`exitReason` and the `critique.decided` event. Spec 30 decision 6 says so, but it differs from the evaluator, which leaves `EVALUATION.md` for the pipeline to commit.
- On the third consecutive revise the run's `exitReason` is `"revise — revision limit reached"`, deliberately not `"revise"`, so `pendingReplanFeedback` does not re-plan the card again when the human approves from plan review. The critic's notes reach the human through the event feed and the run row, not a review row.
- The mock provider tells the critic from the planner by `.ralph/CRITIQUE.md` appearing in the prompt; only `src/prompts/critique.md` mentions that path today.
- Per-card `criticModel` is accepted by the API and inherited on breakdown, but the card edit modal offers only the on/off/default select, not a critic model picker.

```findings
[
  { "severity": "suggestion", "file": "src/app/card/[id]/page.tsx", "issue": "The edit-card modal exposes the planCritic tri-state but no per-card criticModel picker, although the API and breakdown inheritance support the column." },
  { "severity": "suggestion", "file": "src/server/harness/mock.ts", "issue": "roleOf tells critic from planner by the literal '.ralph/CRITIQUE.md' in the prompt; a future planner template or inlined plan mentioning that path would misroute the mock." }
]
```
