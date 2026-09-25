VERDICT: approve

## What I verified

Every whole-card acceptance criterion was run by hand and passes:

- All 20 `grep -q` / `grep -rq` / `test -f` criteria succeed (`splitRegressionCriteria`, `precheckAcceptance`, `PRECHECK_REVISE_EXIT`, `127` in `acceptanceProbe.ts`; `precheck_passing` in `src/db/schema.ts` and `drizzle/0025_precheck_passing_plan_row.sql`; `"acceptance.precheck"` and `"plan.precheck_revise_requested"` in `planningService.ts`; `consecutivePlanRevisions`, exported `MAX_CRITIC_REVISIONS` and `PRECHECK_REVISE_EXIT` in `planCriticService.ts`; `replan(cardId: string): void` dep wired in `orchestrator.ts` to `startStage("planning", cardId)`; `precheckPassing` in the post-DONE probe; `precheck-revise-once` / `precheck-still-inverted` in `harness/mock.ts` and `mockPipeline.test.ts`; `Regression` in `src/prompts/plan.md`; `acceptance.precheck` in `docs/HOW_IT_WORKS.md`; `specs/31-acceptance-precheck.md` exists with its `docs/DESIGN_HISTORY.md` row).
- `npx vitest run src/server/acceptanceProbe.test.ts` → 26 passed. Covers the `## Regression` parser (between sections, case-insensitive, absent), already-passing, inverted criteria, regression skip, missing binary (exit 127, including the `fails` case), timeout (including the `fails` case), abort-before-start and abort-mid-run.
- `npx vitest run src/server/planningService.test.ts` → 32 passed, including the four deterministic cancellation tests (local abort inside the pre-check, peer-finalized run inside the pre-check, local abort during the commit, peer-finalized run whose commit rejects) asserting no plan row / no commit / no event / no replan / no critic / no moveCard / no second finishRun.
- `npx vitest run src/server/planCriticService.test.ts` → 15 passed.
- `npx vitest run src/server/orchestrator.lifecycle.test.ts -t "acceptance probe"` → 5 passed (tolerated check is reported, not repaired; a non-tolerated failure still gets the single repair).
- `npx vitest run src/server/mockPipeline.test.ts -t "precheck"` → 2 passed; the full mockPipeline + lifecycle files also pass (134 tests).
- `npx drizzle-kit check` → migration 0025 and snapshot consistent.
- `make check` → exit 0 per `.ralph/GATE.md` (not re-run).
- Ad-hoc: ran `precheckAcceptance` against a `git archive beta` export using the card's own checks — every new-behaviour check lands in `failing` (the healthy result), `jq` (not installed) lands in `unprobed`, a `## Regression` entry is `skipped`, and a non-allowlisted head is never run.

Code review against the card: the pre-check runs in `runPlanning` after artifact validation and before `writePlanRow`, so it precedes both `ready` and `plan_review` and its event is on the timeline at review time; it reuses `probeCommands`, the sandbox wrapping and `PROBE_TIMEOUT_MS` exactly as `runAcceptanceProbe`; `PROBE_ALLOWED` and `SHELL_METACHARACTER` are untouched. The revise is bounded by `precheck === 0 && critic + precheck < MAX_CRITIC_REVISIONS` and the critic escalates at `critic + precheck >= 2`, so a card can be sent back at most twice in total per planning cycle. `active()` (signal + `runs.status === "running"`) is read after the pre-check and after the plan commit, `finishRun` must return true before `replan`/`critique`/`moveCard`, and the catch path returns first on abort and on a peer-closed row. `pendingReplanFeedback` surfaces the pre-check feedback so `startCard` re-plans rather than restarting the loop. The timeline renders every event type generically, so the new event is visible with no UI change.

## For the human reviewer

1. `next.config.ts` is **unrelated to the card**: the loop added `sharedNodeModulesRoot()` which sets `turbopack.root` to the deepest common ancestor (here `/`) when `<project>/node_modules` is a symlink pointing outside the project. It was done to make `make build` pass in this worktree (node_modules is symlinked to `/repos/radulf/node_modules`). It is a no-op for a fresh clone or the Docker image, and the gate passed with it, but decide whether you want it in this card or as its own change / an environment fix instead.
2. `execCheck` now classifies exit 127 as "did not run" for **both** probes. The post-DONE probe previously treated a missing binary (numeric 127) as a failing check and spent the repair iteration on it; now it is unprobed. This matches the original comment's stated intent and the plan-review requirement, but it is a behaviour change to the post-DONE probe worth knowing about.
3. The pre-check runs while `.ralph/PLAN.md` / `CRITERIA.md` are still on disk (they are removed just before the plan commit), so a very broad check such as `grep -rq pattern .` could match the criteria file itself. The post-DONE probe has the same exposure via `.ralph/PROMPT.md`; not new, just noting it.

```findings
[
  { "severity": "important", "file": "next.config.ts", "issue": "Unrelated to the card: sets turbopack.root to the common ancestor (here '/') when node_modules is a symlink outside the project, added only to make the gate build in this shared-install worktree; no-op in normal layouts but should be consciously accepted or split out." },
  { "severity": "suggestion", "file": "src/server/acceptanceProbe.ts", "line": 261, "issue": "Treating exit 127 as unprobed also changes the post-DONE probe: a missing binary no longer creates a repair task (previously it did); consistent with the file's stated intent but a behaviour change beyond the pre-check." },
  { "severity": "suggestion", "file": "src/server/planningService.ts", "line": 452, "issue": "The pre-check runs with .ralph/PLAN.md and CRITERIA.md still present in the worktree, so a broad recursive grep on '.' could match the criteria document itself; consider excluding .ralph or running after removeRalphFiles with the criteria held in memory." },
  { "severity": "suggestion", "file": "src/server/planCriticService.ts", "line": 157, "issue": "consecutiveCriticRevisions is now only referenced by tests; it could be dropped in favour of consecutivePlanRevisions(...).critic." }
]
```
