VERDICT: approve

## What I verified

Every acceptance criterion was run by hand in this worktree:

**Spec 30**
- `grep -c '28' specs/30-plan-critic.md` → `0`, exit 1 (no matches). ✓
- `grep -c '^# 30: ' specs/30-plan-critic.md` → `1`. ✓
- `grep -q 'Decided 2026-09-24'` and `grep -q 'amends nothing else'` both exit 0. ✓
- `grep -q '30-plan-critic.md' docs/DESIGN_HISTORY.md` exits 0. ✓
- Spec written in its own docs-only commit (`5e74adf`: DESIGN_HISTORY, spec 04 cross-reference, spec 30). ✓

**`make check` regression**
- `npx vitest run src/server/requestValidation.test.ts` → 33/33 pass. ✓
- `grep -q 'criticModel: null' src/server/requestValidation.test.ts` exits 0. ✓

**Critic transcripts**
- `grep -q 'critique: "critique.jsonl"' 'src/app/api/runs/[id]/route.ts'` exits 0. ✓
- `runRoute.test.ts` → 2/2 pass (critique run served on `?iteration=0`, loop run still 400). ✓
  Note for the human: the criterion's literal quoting `'src/app/api/runs/\[id\]/runRoute.test.ts'` makes vitest 4.1.11 report "No test files found" (its filter mangles the escaped brackets to `[id/]`); the unescaped path `'src/app/api/runs/[id]/runRoute.test.ts'` or the substring `runRoute` runs it. That is a quirk of the check command, not of the change.

**Stage diagnosis**
- `grep -q '"plan critic"' src/server/stageDiagnosis.ts` exits 0; `stageDiagnosis.test.ts` → 9/9 pass. ✓

**Critic behaviour**
- `planCriticService.test.ts` + `planningService.test.ts` → 33/33 pass (approve → ready / plan_review, revise → replan with feedback on the run row, third revise → plan_review with "revision limit" reason, illegal file edit → `failed` + needs_attention naming the file, malformed verdict → needs_attention). ✓
- `mockPipeline.test.ts -t critic` → approve path (critique run completed/approve, prompt tokens > 0, `critique.jsonl` on disk, one `critique.decided` event) and `critic-revise-once` (exit reasons `["revise","approve"]`, two plans, plan v2 feedback contains the critique). ✓
- `settings.test.ts` + `cardValidation.test.ts` → 23/23 pass (independent `criticProvider`/`criticModel`/`criticReasoningLevel`, `planCriticMode` validation, per-card `planCritic` on/off/null). ✓
- Harness: `git diff beta...HEAD -- src/server/harness/` touches only `mock.ts`. The criterion's literal command against the `main` merge-base prints 18, but every one of those files is identical to `beta` (beta is ahead of main); the card's base is beta, so the constraint holds. ✓

**Whole-repo gate**
- `npx tsc --noEmit` exit 0; `npx eslint` on the four named files exit 0 (also clean on planCriticService, planningService, orchestrator, mock, card page, settings page). ✓
- Gate (`make lint typecheck build check-split`) exit 0 per `.ralph/GATE.md`. `make test` run twice: run 1 had one failure, `orchestrator.reaper.test.ts > never reaps its own run` — `ENOTEMPTY rmdir /tmp/claude/runtmp`, a race between parallel workers sharing `$TMPDIR/runtmp` (`runScratchRoot()`), passes alone and untouched by this card; run 2: 139 files / 1348 tests pass, exit 0. Together that is `make check` passing. ✓
- `drizzle-kit check` → "Everything's fine"; migration 0023 chains on beta's 0022. ✓

**Code review beyond the criteria**
- `PlanCriticService.runCritic` mirrors the evaluator: sandbox, run row of kind `critique` with planId, HEAD/status snapshots, planner tool set (no bash, writes confined to `.ralph/`), `harnessFailure("critic")`, off-branch check, commit check, illegal-path check, `parseEvaluation` reuse, event, cleanup of `CRITIQUE.md` so the worktree is left as found, `pump()` on every exit.
- `pendingReplanFeedback` now picks up `critique` revise rows on the latest plan with an explicit "The plan critic reviewed the previous plan…" prefix, so the planner does not read it as a review of code.
- Retry of a failed/interrupted critic re-runs the critic in place (`retryFailedStep` `critique` branch); stale-worker reaping parks the card in needs_attention as for any run.
- UI: run label, per-run model/reasoning, `critique.decided` rendered in Events, tri-state Plan critic control on create/edit, fifth agent section in Settings, `planCriticMode` + `criticTimeoutMinutes` controls.
- No unrelated changes; the merge with beta (spec 28) was resolved cleanly (migration renumbered to 0023, no conflict markers).

## Docs reconciled on approve
- `docs/HOW_IT_WORKS.md`: roles table now lists the Plan critic ("five agent roles").
- `specs/03-data-model.md`: `planCritic`/`criticModel` card columns, `critique` run kind, critic settings keys.
- `docs/PROVIDERS.md`: `critic-revise-once` mock scenario row; mock curl example sets `criticProvider`/`criticModel`.

## Things the human reviewer may want to look at
- The revision cap counts `critique` revise runs since the card's latest **loop** run; an approve or a human plan-review intervention does not reset it, so a card re-planned from plan_review after an escalation would escalate again on the next revise. Defensible (a human already saw it), but worth knowing.
- Like the evaluator, a rejected verdict leaves the critic's illegal edits in the worktree; the next critic run's `statusBefore` snapshot then treats them as pre-existing.

```findings
[
  { "severity": "suggestion", "file": "src/server/planCriticService.ts", "line": 119, "issue": "consecutiveCriticRevisions only resets on a loop run, so after a plan_review escalation the next critic revise escalates again immediately rather than allowing two more re-plans" },
  { "severity": "suggestion", "file": "src/server/planCriticService.ts", "line": 268, "issue": "a rejected verdict leaves the critic's illegal edits in the worktree (mirrors the evaluator); a retry's statusBefore snapshot then hides them" },
  { "severity": "suggestion", "issue": "the acceptance-criterion command with backslash-escaped brackets ('src/app/api/runs/\\[id\\]/runRoute.test.ts') finds no files under vitest 4.1.11; the unescaped path runs the test and passes" }
]
```
