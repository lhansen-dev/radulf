VERDICT: approve

## What I verified

Every acceptance criterion was run in this worktree (never overriding `TMPDIR`; full suite not run, per the criteria):

- Spec: `specs/28-epic-dependency-graph.md` exists, says "as a graph", and `specs/24-epics.md` links it. The first commit touching it (`26075f7`) changes only `specs/24-epics.md` and `specs/28-epic-dependency-graph.md` — docs-only, as the card required.
- Schema/migration: `"graph"` in `src/shared/epics.ts`; `depends_on` in `src/db/schema.ts`; exactly one `drizzle/0022_epic_dependencies.sql` (`ALTER TABLE cards ADD depends_on text`); journal has `"idx": 22`; `0022_snapshot.json` exists, chains `prevId` to 0021's id, and differs from 0021 only by the new nullable `depends_on` column (checked with node).
- `npx vitest run src/server/cardValidation.test.ts src/server/epics.test.ts src/server/scoping.test.ts` → 36 passed, exit 0.
- `npx vitest run src/server/orchestrator.scoping.test.ts` → 15 passed, exit 0 (dependencies persisted as sibling ids; cycle rejected naming both titles; nothing persisted on rejection; pre-existing tests unchanged — diff is additions only).
- `grep 'dependency cycle' src/server/orchestrator.ts` → present.
- `npx vitest run src/server/orchestrator.lifecycle.test.ts -t "spec 28"` → 2 passed (cap of two: g-a/g-b start together, g-c waits until g-a Done, g-d with an abandoned dependency starts and emits exactly one `epic.dependency_abandoned` on the epic with `{pieceId, abandoned:[...]}`; Start now starts a piece with an unfinished dependency). `-t "spec 20"` → 1 passed. Full lifecycle file also run: 104 passed.
- `grep 'DEPENDS ON' src/server/scoping.ts` → present; `parseSplitProposal` maps `DEPENDS ON:` card numbers to 0-based indexes of surviving blocks and strips the line; `RUN: as a graph` → `graph`.
- `npx vitest run breakdownEditor.test.tsx scopingPanel.test.tsx src/app/ui/epics.test.ts src/app/api/cards/[id]/scoping/scopingRoutes.test.ts src/app/ui/newTaskDialog.test.tsx` → 42 passed, exit 0. Editor offers "As a graph", shows per-piece dependency checkboxes only in graph mode, remaps `dependsOn` on move/drop, and posts `dependsOn` only under `graph`.
- `grep waitingOn src/app/page.tsx` and `grep 'value="graph"' src/app/card/[id]/epicTasks.tsx` → present. The board API spreads the whole card row so `dependsOn` reaches the feed.
- `npx vitest run src/server/mockPipeline.test.ts` → 12 passed incl. "graph epic" (A and B run together under cap 2, C waits on both, A approved, B abandoned, C runs and merges, epic Done, `epic.dependency_abandoned` recorded).
- `node_modules/.bin/tsc --noEmit` → exit 0. `node_modules/.bin/eslint` → exit 0 (one warning: unused `_drop` in `breakdownEditor.tsx:43`).
- Build: `node_modules` is a symlink to the parent checkout, so the gate's Turbopack failure is the environmental case the card describes. `NODE_ENV=production node_modules/.bin/next build --webpack` → exit 0. `RADULF_SPLIT_CHECK=1 npx vitest run src/server/splitProcesses.test.ts` → one timing-based failure in the single-card transcript-push test on the first run (a file the diff does not touch), 9/9 on rerun.
- Also ran `page.test.tsx`, `cardsRoute.test.ts`, `transferRoutes.test.ts` → all pass; no other test files reference epics.

Code review: `heldByEpicOrder` keeps the `ordered` branch byte-for-byte and adds a `graph` branch over `unmetDependencies` (ghost ids ignored, Abandoned counts as finished); `pump()` is untouched apart from the comment, so `parallel` and pre-spec epics (null `dependsOn`) behave as before. `applyBreakdown` re-validates indexes and runs `findDependencyCycle` before the insert transaction, pre-generates ids so forward references resolve. `startCard` only adds the `epic.dependency_abandoned` note when a graph piece actually leaves Todo — no change to how a single card plans, loops, or evaluates. The breakdown route passes `dependsOn` straight through `parseBreakdown`; the split route returns `SplitCard.dependsOn` into the editor.

## For the human reviewer

- The spec text had drifted from the code in three small places (empty `dependsOn` is stored as `null`, not `[]`; cycle detection lives in `applyBreakdown` and names pieces by title; one `epic.dependency_abandoned` event per piece carrying an `abandoned` id list rather than one per dependency). I reconciled the spec to match the code, and refreshed `docs/HOW_IT_WORKS.md`, `docs/DESIGN_HISTORY.md`, `PRODUCT.md`, and the amended non-goal in `specs/24-epics.md`.
- `waitingOn` also renders "waiting on" lines for `ordered` epics in the Work feed (the card asked for graph). Scheduling is unchanged; this is display only, but a long ordered epic gains one line per queued piece.
- The Jira-children dialog still offers only In order / In parallel — sensible, since Jira children carry no dependency data, but it is the one run-mode picker without `graph`.

```findings
[
  { "severity": "suggestion", "file": "src/app/card/[id]/breakdownEditor.tsx", "line": 43, "issue": "`const { dependsOn: _drop, ...rest } = piece` trips @typescript-eslint/no-unused-vars (warning); a `delete`-free helper or an ignore pattern for `_`-prefixed rest siblings would keep lint clean." },
  { "severity": "suggestion", "file": "src/app/ui/epics.ts", "issue": "waitingOn also emits 'waiting on' lines for ordered epics, so a long ordered epic's feed card grows by one line per queued piece; consider limiting to graph or collapsing when many pieces wait." },
  { "severity": "suggestion", "file": "src/server/scoping.ts", "issue": "parseSplitRunMode tests for `graph` before `parallel`, so a RUN line mentioning both words resolves to graph; harmless given the prompt's format but worth knowing." },
  { "severity": "suggestion", "file": "src/app/ui/newTaskDialog.tsx", "line": 228, "issue": "The Jira-children run-mode picker offers only ordered/parallel; intentional (no dependency data from Jira) but it is the one place `graph` is absent." }
]
```
