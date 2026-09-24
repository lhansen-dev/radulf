VERDICT: approve

The three fixes the previous revise asked for are in place and precisely scoped, and every whole-card criterion passes. The four follow-up commits (3c9207b…8bd3a9f) touch only `specs/30-plan-critic.md`, `src/server/requestValidation.test.ts`, `src/app/api/runs/[id]/route.ts` (+ new `runRoute.test.ts`), and `src/server/stageDiagnosis.ts` (+ test); the fifth commit is a no-op note.

## Criteria verified (all commands run by me on HEAD 0d92e17)

- Spec 30: `grep -c '28'` → `0` (exit 1); `grep -c '^# 30: '` → `1`; `Decided 2026-09-24` and `amends nothing else` both present; `docs/DESIGN_HISTORY.md` has the `30-plan-critic.md` row.
- `npx vitest run src/server/requestValidation.test.ts` → 33/33, exit 0; `criticModel: null` present in the expected object.
- `grep -q 'critique: "critique.jsonl"' src/app/api/runs/[id]/route.ts` → exit 0; `npx vitest run 'src/app/api/runs/[id]/runRoute.test.ts'` → 2/2 (critique run served with `?iteration=0`, loop run still 400). Note: the criterion's literal `'…runs/\[id\]/…'` spelling finds no files because vitest's filter treats the backslashes literally — a quoting quirk of the criterion, not a defect.
- `grep -q '"plan critic"' src/server/stageDiagnosis.ts` → exit 0; `npx vitest run src/server/stageDiagnosis.test.ts` → 9/9.
- `planCriticService.test.ts` (13) + `planningService.test.ts` (20) → 33/33; `mockPipeline.test.ts -t critic` → approve and revise-once paths pass; `settings.test.ts` (7) + `cardValidation.test.ts` (8) → 15/15.
- Harness: only `src/server/harness/mock.ts` changed against the actual base (`beta`, merge-base 620e94e). The criterion's `origin/main` form prints 18 because this branch is off `beta`, which is 240 commits ahead of `main`; those files are beta's history, not this card's.
- `npx tsc --noEmit` → exit 0; `npx eslint` on the four named files → exit 0.
- `make check`: full vitest suite run once — 19 failures in 5 files, every one on the card's environmental list (`bookkeeping.test.ts` EROFS on `/tmp`, 10 `harness/index.test.ts` watchdog tests, 2 `streamLiveness.test.ts`, 4 real-runtime `sandbox/srt.test.ts` rows) plus the 3 `evaluationService.test.ts` spec 26/27 timeout tests, which I confirmed fail identically on a `git archive` export of merge base 620e94e. 1303 tests pass, including `settings/page.test.tsx` and `newTaskDialog.test.tsx`. Gate: lint/typecheck/build passed; `check-split` failed in the gate with `SQLITE_BUSY` during web2's first DB open (`db/index.ts createDb`, untouched by this card; five errors over 120 s ≈ two 60 s migration-lock timeouts). I re-ran `RADULF_SPLIT_CHECK=1 npx vitest run src/server/splitProcesses.test.ts` alone against the gate's own `.next` build → 9/9 pass, so the gate failure was a boot-race flake.

## Code review

Read-only enforcement (HEAD compared, `git status` diff filtered to `.ralph/CRITIQUE.md`), shared `parseEvaluation`, approve → `planningDestination(card)`, revise → run `feedback` + `replan`, third consecutive revise → `plan_review` with the feedback on the run row and in the `critique.decided` event; `pendingReplanFeedback` prefixes critique feedback so the planner knows no code existed; `criticEnabled` honours per-card override then `planCriticMode`; breakdown pieces inherit `planCritic`/`criticModel`; `retryFailedStep` has a `critique` branch; `harnessFailure`/`renderDeadlineSection` widened; mock `roleOf` distinguishes the critic by the verdict path in its prompt. No unrelated changes; the drizzle snapshot is generated.

## For the human reviewer

- `consecutiveCriticRevisions` resets only on a loop run, so after a critic escalation → human plan-review rejection → re-plan, the critic's next revise escalates straight back to plan review (prior count is already 2). Defensible since a human is already involved, but worth a conscious decision.
- Card export/import (`cardTransfer.ts`) does not carry `planCritic`/`criticModel`.
- The mock's `roleOf` identifies the critic by `.ralph/CRITIQUE.md` appearing in the prompt; a critic revise whose feedback quotes that path would make the mock planner's re-plan prompt match too. Mock-only.

Docs reconciled on approve: added the Plan critic row to the role table in `docs/ARCHITECTURE.md` and a short paragraph to `docs/HOW_IT_WORKS.md` between Plan and Loop.

```findings
[
  { "severity": "suggestion", "file": "src/server/planCriticService.ts", "line": 119, "issue": "consecutiveCriticRevisions is reset only by a loop run, so after a plan-review rejection and re-plan the critic's first new revise escalates straight to plan_review." },
  { "severity": "suggestion", "file": "src/server/cardTransfer.ts", "issue": "Card export/import does not carry the new planCritic/criticModel columns, so the per-card override is lost on round-trip." },
  { "severity": "suggestion", "file": "src/server/harness/mock.ts", "line": 305, "issue": "Mock roleOf detects the critic by '.ralph/CRITIQUE.md' in the prompt; a re-plan prompt that quotes critic feedback mentioning that path would be misread as a critic turn (mock-only)." }
]
```
