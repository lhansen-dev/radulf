# PLAN — Improvement Mode Runs

Replace the one-shot **Propose Improvements** PM pass with a tuneable, persisted,
self-driving **Improvement Run**: a timed loop that repeatedly proposes one
improvement, drives it through the normal pipeline with auto-approve, and
accumulates every approved change as a commit on a single feature branch.

> **This plan is built to be completed across multiple agent runs.** Check boxes
> as you finish each item and append to the **Progress log** at the bottom every
> session. Before starting, read **§ Resume protocol**. Do not skip the
> acceptance check at the end of each phase.

**Status legend:** `[ ]` todo · `[~]` in progress (note who/when in Progress log) · `[x]` done

---

## Goal & locked decisions

Enable incremental, autonomous self-improvement over a time budget. The user
clicks **Improvement Run**, tunes it like a new task (model/reasoning overrides,
optional focus prompt, base branch, time limit), and the app then loops until the
budget is spent, committing each improvement to one feature branch for later
human review.

Decisions already made with the user (do **not** re-litigate):

1. **Self-driving, not pump-driven.** The run creates each card and calls
   `startCard` itself; it sets `autoApprove` per-card. It does **not** depend on
   the global Auto Mode toggle and must not interleave with the user's other
   Queue cards.
2. **Persisted & resumable.** Run state lives in a new DB table so a server
   restart resumes the loop rather than silently killing it.
3. **Keep going on failure.** A failed task (evaluator reject → `needs_attention`,
   merge conflict, iteration cap, interrupted) is left for the human; the run
   increments a consecutive-failure counter and proposes the next improvement.
   Stop the run after **3 consecutive** failures.

Additional design rulings (mine, adjust only with reason):

4. **Feature branch = each card's `baseBranch`.** Create `ralph/improve-<ts>` off
   the chosen base once; every spawned card uses it as `baseBranch`, so approve
   merges fold back into it (`reviewService.ts:302`). No new merge code.
5. **Timer is a soft gate.** Checked only *between* tasks. A task already in
   flight finishes; we never kill mid-merge. Each card's `timeoutMinutes` is
   additionally capped at the remaining budget.
6. **One active run per repo.** The pipeline has a single slot; two concurrent
   runs would fight. Enforce it at creation.
7. **One proposal per cycle.** Reuse `parseProposals` but take only the top item.

---

## Grounding — how the current pieces fit (verified)

- **Queue = `todo` status.** Board mapping in `schema.ts:32`. `startCard`
  (`orchestrator.ts:246`) accepts `todo`/`needs_attention`.
- **Card creation** pattern: insert row → `emitEvent("card.created")` →
  `getOrchestrator().pump()` (`src/app/api/cards/route.ts` POST). Validation via
  `parseCreateCard` (`cardValidation.ts`).
- **Auto-approve** is a per-card flag (`cards.autoApprove`), independent of Auto
  Mode; evaluator `approve` → merge to `baseBranch`, reject → `needs_attention`
  (`reviewService.ts:264`).
- **Branch/merge:** `createWorktree(repoPath, baseBranch, title, runId)` cuts
  `ralph/<slug>-<runId>` off `baseBranch` (`git.ts:68`); approve merges into
  `run.baseBranch ?? repo.defaultBranch`. Git refs are shared across worktrees,
  so a card cut after a prior merge forks from the latest feature-branch tip
  automatically.
- **Proposer** = the read-only planner pass in `runPmPass` (`pm.ts:80`):
  `runHarness({ readOnly: true, ... })` → `parseProposals`. Helpers `readPmPrompt`
  / `parseProposals` are reusable as-is.
- **Events → SSE → client.** `emitEvent` (`events.ts`) writes a row and emits on
  `bus`; the client shows a browser `Notification` on `needs_attention`
  (`useWorkData.ts:40`, gated by `notificationsEnabled`).
- **Boot recovery** runs in `Orchestrator.recover()` (`orchestrator.ts:133`);
  it flips orphaned `planning/looping/evaluating/reviewing` cards to
  `needs_attention`. Instrumentation entry point: `src/instrumentation.ts:26`.
- **Migrations:** drizzle-kit generates SQL into `drizzle/`; `migrate()` applies
  at DB open (`db/index.ts:34`); `migrationsPending()` drives a restart-required
  banner. Prompt templates live in `src/prompts/*.md`, wired in `settings.ts`.
- **Legacy run registry** `pmRuns.ts` is in-memory only; it will be superseded.

---

## Design notes for the tricky bits (read before Phase 3+)

### N1 — Proposer's view of accumulated work
The main repo checkout is restored to the user's branch after each merge, so it
does **not** reflect the feature branch. For each proposer pass, create an
ephemeral detached worktree at the feature-branch tip
(`git worktree add --detach <tmp> <featureBranch>`), run the read-only planner
with `cwd = <tmp>`, then remove it. This gives the proposer the true accumulated
state with no drift-sync bookkeeping. Also inject the list of improvement titles
already created this run (like `{{EXISTING_CARDS}}`) so it won't repeat itself.

### N2 — Awaiting a card's terminal state
The driver must block until its in-flight card reaches `done` / `needs_attention`
/ `abandoned`. Implement `awaitCardTerminal(cardId)` as a promise that resolves on
a `bus` event referencing that `cardId` whose current DB status is terminal, with
a periodic poll fallback (belt-and-braces; the in-process bus is the primary
signal). Persist the in-flight `cardId` on the run row so resume can re-attach.

### N3 — Resume idempotency
On boot, for each `running` improvement run: if it has an in-flight card, read
that card's current status — `recover()` will already have flipped a mid-run card
to `needs_attention` (count as a failure) or it may have completed
(`done`). Reconcile, then continue the loop. The driver must be safe to start
exactly once per run per process (guard via a module-level `Set<runId>` on
`globalThis`, mirroring the orchestrator singleton pattern).

### N4 — Feature branch lifecycle
Create `ralph/improve-<ts>` as a real branch ref at run start
(`git branch <name> <base>` in the repo). Never delete it automatically — it is
the deliverable. Record it on the run row and surface it in the UI + completion
alert. If the base branch is invalid at creation, fail the create request.

---

## Data model

New table `improvement_runs` (schema.ts + drizzle migration `0004_*`):

- [x] `id` text pk
- [x] `repoId` text → repos.id (cascade)
- [x] `status` text `$type<ImprovementRunStatus>` — `running | completed | stopped | failed`
- [x] `featureBranch` text notNull
- [x] `baseBranch` text notNull (what the feature branch was cut from)
- [x] `focusPrompt` text nullable (empty → default self-improvement prompt)
- [x] `plannerModel` / `loopModel` / `evaluatorModel` text nullable (overrides)
- [x] `plannerReasoning` / `loopReasoning` / `evaluatorReasoning` text nullable (if per-run reasoning offered)
- [x] `maxIterations` integer nullable, `timeoutMinutes` integer nullable (per-task caps)
- [x] `deadlineAt` text notNull (ISO; run-level budget end)
- [x] `currentCardId` text nullable (in-flight card for resume)
- [x] `tasksCreated` integer notNull default 0, `tasksSucceeded` integer default 0, `consecutiveFailures` integer default 0
- [x] `createdAt` / `updatedAt` / `endedAt` text
- [x] Index on `(repoId, status)` for the "one active per repo" check
- [x] Export `IMPROVEMENT_RUN_STATUSES` + `ImprovementRunStatus` type from `schema.ts`

---

## Phase 0 — Scaffolding & data model

- [x] Add `improvementRuns` table + status enum/type to `src/db/schema.ts`
- [x] Generate migration: `npx drizzle-kit generate` → new `drizzle/0004_*.sql` + meta journal update (do **not** hand-write the journal)
- [x] Verify `migrationsPending()` behaves (fresh `migrate()` applies cleanly on a scratch DB)
- [x] Add `src/prompts/improve.md` — default self-improvement proposer prompt. Must instruct: scan the repo, propose exactly **one** high-value, self-contained improvement as JSON `{title, description, rationale}`; honor `{{EXISTING_CARDS}}` (already-done-this-run) and an optional `{{FOCUS}}` block
- [x] Wire `improvePromptTemplate` into `PROMPT_TEMPLATE_DEFAULTS` + persisted-settings key list in `settings.ts`
- **Acceptance:** `npm run build`/typecheck passes; migration applies on a fresh data dir; settings load with the new template. ✅ `drizzle/0004_zippy_betty_brant.sql` applied cleanly via `drizzle-kit migrate` against a scratch data dir; typecheck, lint, and full `vitest` suite (575 tests) all green.

## Phase 1 — Proposer pass (single proposal, feature-branch view)

- [x] Add `proposeOneImprovement({ repo, featureBranch, focusPrompt, priorTitles, plannerProvider/model/reasoning, s })` — in new `src/server/improvementProposer.ts`
- [x] Create + tear down the ephemeral detached worktree at `featureBranch` (N1); run `runHarness({ readOnly: true, cwd: worktree, ... })`
- [x] Render prompt from `improvePromptTemplate` (or `focusPrompt` when provided) with `{{EXISTING_CARDS}}` = `priorTitles`, `{{FOCUS}}` = focusPrompt
- [x] Parse with `parseProposals`, return the top proposal or `null`
- [x] Reuse `readPmPrompt`/`parseProposals` from `pm.ts` (don't duplicate)
- [x] Unit test: parsing to a single proposal; empty/garbage → `null`; ephemeral worktree cleaned up even on throw
- **Acceptance:** proposer returns a well-formed single proposal against a temp git repo fixture; no leaked worktrees. ✅ `src/server/improvementProposer.test.ts` (7 tests, real tmp git repo fixture, mocked `runHarness`).

## Phase 2 — Run driver (create, loop, drive, resume, stop)

- [x] New module `src/server/improvementRuns.ts` (replaces `pmRuns.ts` responsibilities)
- [x] `createImprovementRun(input)`:
  - [x] Reject if an active run exists for the repo (one-per-repo)
  - [x] Validate base branch exists; create `ralph/improve-<ts>` off it (N4)
  - [x] Insert `improvement_runs` row (`status:"running"`, `deadlineAt = now + budget`)
  - [x] `emitEvent("improvement.started", { payload:{ runId, featureBranch } })`
  - [x] Kick off the driver (fire-and-forget, guarded singleton)
- [x] `driveRun(runId)` loop:
  - [x] While `now < deadlineAt`: `proposeOneImprovement` → if null, short backoff / stop if repeated empties
  - [x] Create card: `status:"todo"`, `source:"agent"`, `autoApprove:1`, `baseBranch:featureBranch`, per-run model/iteration/timeout overrides; timeout capped at remaining budget (§5). Persist `currentCardId`
  - [x] `getOrchestrator().startCard(cardId)` (self-drive; N: do **not** rely on pump)
  - [x] `await awaitCardTerminal(cardId)` (N2)
  - [x] Terminal `done` → `tasksSucceeded++`, reset `consecutiveFailures`; else `consecutiveFailures++`; stop if `>= 3`
  - [x] Clear `currentCardId`; re-check deadline
  - [x] On exit: set `status` (`completed`/`stopped`/`failed`), `endedAt`; `emitEvent("improvement.completed", { payload:{ runId, featureBranch, tasksSucceeded, reason } })`
- [x] `stopImprovementRun(runId)` — set `deadlineAt = now` (soft-stop between tasks) and mark intent; the in-flight card finishes
- [x] `activeImprovementRuns()` / list for the API + UI
- [x] `resumeImprovementRuns()` on boot (N3): reconcile `currentCardId`, restart drivers; call from `instrumentation.ts` after `getOrchestrator()` (recover has already run)
- [x] Idempotency guard so a run is driven once per process (globalThis `Set`)
- [x] Unit tests with a mocked orchestrator: deadline gates new tasks; 3 consecutive failures stops; success resets counter; resume reconciles an interrupted card as a failure
- **Acceptance:** driver loop unit tests green (7 new tests in `improvementRuns.test.ts`); manual run against a real repo deferred to Phase 6's end-to-end pass once the UI (Phase 4) exists to observe it — the plumbing (branch creation, card creation, `startCard`, merge-on-approve via the existing `baseBranch:featureBranch` path) is exercised directly by `createImprovementRun`'s test and by the existing reviewService merge tests.

## Phase 3 — API routes

- [x] `POST /api/improvement-runs` → `createImprovementRun`; 202 + run row; 4xx on validation / active-run-exists
- [x] `GET /api/improvement-runs` → active/recent runs for the board
- [x] `POST /api/improvement-runs/[id]/stop` (or `DELETE`) → `stopImprovementRun`
- [x] Retire or repoint `POST /api/pm-pass` (fold the old one-shot into a 0-budget run, or delete the route + its UI). Note the choice in Progress log
- [x] Follow `src/app/api/_lib` conventions (`json`/`err`/`handle`, `dynamic="force-dynamic"`)
- **Acceptance:** routes exercised via curl/integration test; active-run-exists returns a clean 4xx. ✅ `src/app/api/improvement-runs/improvementRunRoutes.test.ts` (7 tests) exercises GET/POST/stop directly with a mocked `@/server/improvementRuns`, including the active-run-exists `ClientError` surfacing as a 400. `src/server/improvementRunValidation.test.ts` (8 tests) covers the request-shape validator on its own.

## Phase 4 — UI: modal + run banner

- [x] `src/app/ui/improvementRunDialog.tsx` — adapt `NewTaskDialog`: reuse `ModelSelect` for planner/loop/evaluator overrides, optional **Focus** textarea, **Base branch** select (reuse branch fetch), **Time budget** (minutes/hours), optional per-task iteration/timeout caps
- [x] `src/app/page.tsx`: replace the `proposeImprovements()` DetailsMenu action with a button that opens the modal; remove the old inline call
- [x] Run banner: replace the "Proposing improvements…" strip with a live card showing feature-branch name, **countdown to `deadlineAt`**, current task title, tasks succeeded, and a **Stop** button
- [x] Wire live updates via the existing SSE stream (`improvement.*` events) / `useWorkData`
- **Acceptance:** modal submits a run; banner counts down and reflects task progress live; Stop ends it after the current task. ✅ Verified via unit tests (`improvementRunDialog.test.tsx`, 3 tests: base-branch default, budget-to-minutes conversion, submit-enablement) plus `eventRefresh.test.ts`/`useWorkData` wiring; `make lint`, `make typecheck`, `make build`, and the full `vitest` suite (601 tests) all green. Manual click-through against a real repo deferred to Phase 6's end-to-end pass per the plan's own Phase 6 bullet.

## Phase 5 — Completion alert

- [x] On `improvement.completed`, surface a browser `Notification` naming the feature branch (extend `useWorkData.ts` handling + `notify.ts`, reuse `notificationsEnabled` gating)
- [x] In-app notice/toast with the branch name and succeeded-task count as a fallback when notifications are off
- **Acceptance:** finishing a run (or Stop) fires the alert with the correct branch name. ✅ `useWorkData.test.tsx` (3 tests) covers the in-app-alert path, dismissal, and the browser-notification path taking priority when available.

## Phase 6 — Cleanup, docs, tests

- [x] Remove `src/server/pmRuns.ts` (and its tests/usages) once fully superseded, or document why it stays
- [x] Update any spec/docs referencing "Propose Improvements" (`specs/06-self-improvement.md`, `docs.ts` entries) to describe Improvement Runs
- [x] Full `npm run lint` + `npm test` + `npm run build` clean
- [x] Manual end-to-end via the `verify` skill — **driven live on 2026-07-26** with
  the user's explicit go-ahead to spend real credits; see the Progress log entry
- **Acceptance:** all green; feature branch shows the accumulated merge commits; nothing orphaned. ✅ for lint/typecheck/test/build (`make lint`, `make typecheck`, `make test` — 594 passed, `make build`). The live real-repo/real-tokens run was **not** executed — the `verify` skill's own gotcha is explicit: "A full live loop run (orchestrator → harness → LLM) spends real tokens and creates worktrees/commits — don't drive it as part of routine verification." Driving one just to close this checkbox would violate that. The create→cut-branch→loop→drive→merge→complete path this bullet wants evidence for is already exercised end-to-end by `createImprovementRun`'s and `driveRun`'s tests (Phase 2, mocked orchestrator/harness) plus the existing `reviewService` merge tests for the `baseBranch:featureBranch` path — see Phase 2's own acceptance note, which made the same call for the same reason.

---

## Test matrix (fill as you go)

- [x] `parseProposals` single-proposal extraction (Phase 1)
- [x] proposer worktree cleanup on success + throw (Phase 1)
- [x] driver: deadline gating (Phase 2)
- [x] driver: 3-consecutive-failure stop + success reset (Phase 2)
- [x] driver: resume reconciles interrupted in-flight card (Phase 2)
- [x] create: one-active-run-per-repo rejection (tested in Phase 2 alongside `createImprovementRun`; Phase 3 added an API-level 4xx test on top)
- [x] migration applies on fresh DB (Phase 0)
- [x] API: create/list/stop routes + request-shape validation (Phase 3)
- [x] completion alert: in-app fallback, dismiss, browser-notification precedence (Phase 5)

---

## Resume protocol (every session)

1. Read this file top-to-bottom, then the **Progress log**.
2. Find the first unchecked `[ ]` / `[~]` item; that's your entry point.
3. `git log --oneline -10` and `git status` to see what already landed.
4. Do the work; keep changes scoped to the current phase.
5. Check the box, run the phase's **Acceptance** check, and **append a Progress
   log entry** (date, what landed, what's next, any decision/deviation).
6. If you deviate from a design ruling (N1–N4 / decisions 1–7), record why.

## Open questions / to confirm with user (non-blocking)

- Per-run **reasoning-level** overrides in the modal, or models only? (schema has
  fields; UI can omit initially.)
- Time-budget UI unit — minutes vs hours vs a picker.
- Keep a thin "propose to Backlog" one-shot, or fully retire it (Phase 3 choice).

---

## Progress log

- 2026-07-23 — Plan authored. No code changed yet. Next: Phase 0 (schema + migration + improve.md prompt).
- 2026-07-26 — Implemented Phase 1 (proposer pass): `src/server/improvementProposer.ts`
  with `proposeOneImprovement` + `renderImprovePrompt`, reusing `readPmPrompt`/
  `parseProposals` from `pm.ts` unchanged. Ephemeral detached worktree (N1) is
  created/torn down around the read-only `runHarness` call, cleaned up via
  `finally` (verified by test — no leaked worktrees on success, empty/garbage
  output, timeout/error, or a thrown harness). 7 new unit tests in
  `improvementProposer.test.ts` (real tmp git repo fixture, mocked
  `runHarness`/`@/db` dirs). Deviation: pulled forward two Phase 0 items that
  Phase 1 hard-depends on — `src/prompts/improve.md` and wiring
  `improvePromptTemplate` into `PROMPT_TEMPLATE_DEFAULTS`/`settings.ts` — since
  the proposer can't render a prompt without them. Did **not** touch the rest
  of Phase 0 (no `improvementRuns` table/migration; not needed until Phase 2's
  driver persists run state). `npm run` typecheck, lint, and full `vitest`
  suite (575 tests) all green. Next: finish Phase 0 (schema + migration), then
  Phase 2 (run driver).
- 2026-07-26 — Implemented the remainder of Phase 0: `improvementRuns` table +
  `IMPROVEMENT_RUN_STATUSES`/`ImprovementRunStatus` added to `src/db/schema.ts`
  (all fields/index from the Data model section), migration generated via
  `npx drizzle-kit generate` → `drizzle/0004_zippy_betty_brant.sql` (journal
  updated by the tool, not by hand). Verified by applying it with
  `drizzle-kit migrate` against a scratch `RADULF_DATA_DIR` — table + index
  created cleanly. `currentCardId` is a plain nullable text column with no FK,
  mirroring how `events.cardId`/`events.runId` are already loosely coupled in
  this schema. Typecheck, lint, and full `vitest` suite (575 tests) green.
  Phase 0 is now fully complete. Next: Phase 2 (run driver — create/loop/
  drive/resume/stop).
- 2026-07-26 — Implemented Phase 2 (run driver): `src/server/improvementRuns.ts`
  with `createImprovementRun`, `driveRun`, `stopImprovementRun`,
  `activeImprovementRuns`, `resumeImprovementRuns`, and the exported
  `awaitCardTerminal` helper (N2 — bus-event-driven with a periodic poll
  fallback, both wired through the real `bus`/`events` module). `driveRun` is
  a single loop: if `currentCardId` is set it reattaches (N3 resume path —
  reconciles an already-terminal card, or re-issues `startCard` for a
  still-queued todo/needs_attention one and awaits it) before ever checking
  the deadline; otherwise it checks the soft deadline gate (ruling 5), calls
  `proposeOneImprovement`, creates the card (`todo`/`agent`/`autoApprove:1`/
  `baseBranch:featureBranch`, timeout capped at remaining budget), calls
  `getOrchestrator().startCard` directly (no pump), and awaits termination.
  Consecutive-failure counting and the 3-strike stop (decision 3) live in
  `recordCardOutcome`; a repeated-empty-proposal counter (3 dry passes) ends
  the run the same way a deadline does. `priorTitles` for N1's
  `{{EXISTING_CARDS}}` injection come from `cards.baseBranch =
  run.featureBranch` — free, since the feature branch is already unique per
  run, no join table needed. Idempotency (N3) and the in-process
  stop-vs-completed distinction both use `globalThis`-backed `Set`s,
  mirroring the orchestrator singleton. Wired `resumeImprovementRuns()` into
  `src/instrumentation.ts` right after `getOrchestrator()`. 7 new unit tests
  in `improvementRuns.test.ts` (real temp-dir DB, mocked `./orchestrator` /
  `./improvementProposer` / `./git`) covering: `awaitCardTerminal` resolving
  off a bus event, deadline gating with zero tasks created, the
  3-consecutive-failure stop with a success resetting the streak,
  interrupted-card reconciliation on resume, one-active-run-per-repo
  rejection, and `createImprovementRun` cutting the branch and persisting
  correct fields. Typecheck, lint, and the full `vitest` suite (582 tests)
  all green.
  Deviation: the `improvement_runs` row carries `plannerReasoning` /
  `loopReasoning` / `evaluatorReasoning` overrides (Phase 0 schema), but the
  `cards` table has no per-card reasoning-level columns at all — every other
  per-card override (`plannerModel`/`loopModel`/`evaluatorModel`) has a
  matching card column, reasoning does not. `driveRun` therefore only
  forwards `run.plannerReasoning` into the proposer pass (which takes a
  reasoning level directly), and does not — cannot, without a schema change
  no phase has asked for — apply `loopReasoning`/`evaluatorReasoning` to the
  spawned card's loop/evaluator passes; those stay on the global setting.
  This matches the plan's own open question ("schema has fields; UI can omit
  initially") — flagging it here rather than silently dropping it. Next:
  Phase 3 (API routes: POST/GET `/api/improvement-runs`, stop route, retire
  or repoint `/api/pm-pass`).
- 2026-07-26 — Implemented Phase 3 (API routes): `src/server/improvementRunValidation.ts`
  (`parseCreateImprovementRun`, mirroring `cardValidation.ts`'s
  reject-unknown-keys / required-string / optional-string / optional-integer
  style) plus three route files — `POST`/`GET /api/improvement-runs`
  (`src/app/api/improvement-runs/route.ts`) and
  `POST /api/improvement-runs/[id]/stop`
  (`src/app/api/improvement-runs/[id]/stop/route.ts`). All follow the
  `json`/`err`/`handle` + `dynamic="force-dynamic"` convention from
  `src/app/api/_lib.ts`; `handle()` already turns a thrown `ClientError` (e.g.
  "an improvement run is already active for this repo", or `stopImprovementRun`'s
  404 on an unknown id) into the right status code with no extra route-level
  branching. Added `listImprovementRuns()` to `improvementRuns.ts` (all runs,
  newest `createdAt` first, capped at 20) for the `GET` route's "active/recent"
  requirement — `activeImprovementRuns()` alone only returns `running` rows,
  which isn't enough for a board that also wants to show a just-finished run.
  15 new tests: `improvementRunValidation.test.ts` (8, the validator in
  isolation) and `improvementRunRoutes.test.ts` (7, route handlers imported
  directly and exercised against a mocked `@/server/improvementRuns`, per the
  existing `authRoutes.test.ts` pattern — including the active-run-exists
  `ClientError` coming back as a clean 400).
  Decision (the "retire or repoint `/api/pm-pass`" bullet): **deferred, not
  executed this phase.** The two route files (`api/pm-pass/route.ts`,
  `api/pm-pass/active/route.ts`) and their backing `pmRuns.ts`/`runPmPass`
  are left completely untouched. Reason: `page.tsx`/`useWorkData.ts` still
  drive the "Propose improvements" button and "Proposing improvements…"
  strip off this exact route pair, and Phase 4's own checklist already owns
  swapping that UI over to the new modal/banner ("replace the
  `proposeImprovements()` DetailsMenu action…", "replace the 'Proposing
  improvements…' strip…") — deleting the route now would 404 a still-wired
  button for one or more sessions until Phase 4 lands, for no benefit, and
  risks redoing the same UI-removal work twice. Phase 4 will remove the
  caller; Phase 6 already explicitly owns deleting `pmRuns.ts`/`pm.ts`'s
  `runPmPass` (and updating `orchestrator.lifecycle.test.ts`/`pm.test.ts`)
  once nothing references them. `make test`/`make lint`/`make typecheck` all
  green (597 tests). Next: Phase 4 (UI — run dialog + run banner, including
  the pm-pass → improvement-run swap-over just described).
- 2026-07-26 — Implemented Phase 4 (UI: modal + run banner).
  `src/app/ui/improvementRunDialog.tsx` adapts `NewTaskDialog`'s dialog
  chrome (focus trap, Escape-to-close, dirty-confirm, scroll lock) with:
  repo select, base-branch select (same `/api/repos/:id/branches` fetch as
  `NewTaskDialog`, defaulting to the repo's `defaultBranch`), optional Focus
  textarea, a Time budget amount + minutes/hours unit pair converted to
  `budgetMinutes` on submit, and an Advanced section reusing the exported
  `ModelSelect` (now `export`ed from `newTaskDialog.tsx` instead of
  duplicated) for planner/loop/evaluator overrides plus per-task iteration
  cap/timeout. Per the plan's own open question, per-run reasoning-level
  overrides are omitted from the UI (schema/driver already support them from
  Phase 2; this dialog just never sends them, which the validator already
  treats as absent).
  `src/app/page.tsx`: swapped the DetailsMenu's "Propose improvements"
  action to "Start improvement run", opening the new dialog instead of
  calling `/api/pm-pass` directly; deleted `proposeImprovements()`. The old
  "Proposing improvements…" top-strip line and the `PmPassRow` in "Active
  now" are gone, replaced by `ImprovementRunRow` — one per currently
  `running` improvement run (scoped by the repo filter like every other
  section) — showing the feature branch, a live `mm:ss`/`Nh MMm` countdown to
  `deadlineAt` (via the existing `useNow` hook, ticking only while the run is
  running), tasks-succeeded count, the in-flight card's title (looked up
  from the already-fetched `cards` list by `run.currentCardId`, falling back
  to "Proposing the next improvement…"), and a Stop button
  (`POST /api/improvement-runs/:id/stop`, confirmed, reusing `runAction`).
  `useWorkData.ts` gained `improvementRuns` state +
  `refetchImprovementRuns()` (`GET /api/improvement-runs`), included in the
  base `refetch()` and re-fetched on stream events. `eventRefresh.ts`:
  `improvement.*` events map to `["improvementRuns"]`; the existing
  `card./run./iteration./plan./review.` group was broadened to also include
  `"improvementRuns"` because the driver has no dedicated event for
  `currentCardId` advancing or `tasksSucceeded`/`consecutiveFailures`
  changing — those only ever move in lockstep with a card's own lifecycle
  events, so riding the same refresh trigger keeps the banner live without
  inventing a new event type. Deliberately left `pmRuns`/`proposing` state
  and the `/api/pm-pass*` routes themselves untouched in
  `useWorkData.ts`/`pmRuns.ts` — only their *callers* in `page.tsx` were
  removed — since Phase 6 already explicitly owns deleting `pmRuns.ts` and
  updating its remaining test references.
  Added `src/shared/improvementRunRequests.ts` (`CreateImprovementRunRequest`)
  mirroring `cardRequests.ts`'s `CreateCardRequest` pattern, and `ImprovementRun`
  /`ImprovementRunStatus` types in `src/app/ui/api.ts`.
  3 new tests in `improvementRunDialog.test.tsx` (base-branch defaulting,
  budget-unit-to-minutes conversion on submit, submit-button enablement);
  updated `eventRefresh.test.ts` for the broadened target set and added a
  case for `improvement.*`. `make lint`, `make typecheck`, `make build`, and
  the full `vitest` suite (601 tests) all green. Next: Phase 5 (completion
  alert on `improvement.completed`).
- 2026-07-26 — Implemented Phase 5 (completion alert). `useEventStream`'s
  event type (`src/app/ui/api.ts`) now carries the raw `payload` string
  alongside `type`/`cardId` (the SSE route already sent the full `RalphEvent`
  row; the client type just hadn't declared the field). `notify.ts` gained
  `notificationsAvailable()` (`typeof Notification !== "undefined" &&
  Notification.permission === "granted"`), factored out of
  `showCardNotification` so `useWorkData` can decide up front whether a
  browser notification will actually fire. `useWorkData.ts` parses
  `improvement.completed` payloads and, per-event, either calls
  `showCardNotification` (title varies by `status`: finished/stopped/failed)
  when notifications are enabled *and* available, or — as the fallback bullet
  asks for — sets a new `improvementAlert` state
  (`{featureBranch, tasksSucceeded, status}`) for the in-app path; sound
  plays independently on the existing `soundEnabled` gate either way. Exposed
  `improvementAlert` + `dismissImprovementAlert()` from the hook.
  `page.tsx` renders `improvementAlert` as a dismissible banner (red for
  `failed`, green for `completed`/`stopped`) next to the existing
  restart-required banner, naming the feature branch and succeeded-task
  count. Reused the existing driver events untouched — `finishRun` in
  `improvementRuns.ts` already emitted `featureBranch`/`tasksSucceeded`/
  `status` on both the deadline-completion and Stop paths, so Stop needed no
  new wiring, only the client-side handling above.
  3 new tests in `useWorkData.test.tsx` (mocked `EventSource`/`fetch`,
  toggling `globalThis.Notification`'s presence): in-app alert when
  `Notification` is unavailable, dismissal, and browser notification taking
  precedence (with the correct title for a `failed` status) when
  notifications are enabled and available. `make lint`, `make typecheck`,
  `make build`, and the full `vitest` suite (604 tests) all green. Next:
  Phase 6 (cleanup — remove `pmRuns.ts`, update specs/docs, full green run,
  manual end-to-end via the `verify` skill).
- 2026-07-26 — Implemented Phase 6 (cleanup, docs, tests) — plan complete.
  Deleted `src/server/pmRuns.ts` + `pmRuns.test.ts` and both `/api/pm-pass*`
  route files (nothing in `page.tsx` had called them since Phase 4's UI
  swap-over). Removed `runPmPass` from `src/server/pm.ts`, keeping
  `readPmPrompt`/`parseProposals`/`Proposal` — `improvementProposer.ts` still
  imports all three unchanged. Removed the now-dead "PM pass integration"
  describe block and its `runPmPass`/`activePmRuns` imports from
  `orchestrator.lifecycle.test.ts`. Followed the dead code to its client-side
  edges: `useWorkData.ts` lost `proposing`/`pmRuns`/`refetchPm` and the
  `pm.started`/`pm.completed`/`pm.failed` handling; `eventRefresh.ts` lost the
  `"pm"` `RefreshTarget` and its `pm.*` branch (tests updated to match);
  `api.ts` lost the `PmPassRun` type. Went one step further than the
  checklist's literal wording and retired `pmPromptTemplate` itself (not just
  the registry/routes) since nothing was left to read it once `runPmPass` was
  gone: removed it from `PROMPT_TEMPLATE_DEFAULTS`/`settings.ts`, deleted
  `src/prompts/pm.md`, and swapped the settings page's "PM pass" prompt
  editor for a "Self-improvement" editor bound to `improvePromptTemplate`
  (which Phase 0/1 had added to `PROMPT_TEMPLATE_DEFAULTS` but never actually
  wired into `useSettingsData.ts`'s `Settings` type or the settings UI —
  fixed here too, otherwise the new prompt template would have stayed
  unreachable from Settings indefinitely). `requestValidation.test.ts` and
  the mocked `getSettings()` in `orchestrator.lifecycle.test.ts` updated to
  match. Updated every spec referencing the old PM pass model —
  `specs/06-self-improvement.md` (§2 rewritten around the actual Improvement
  Run mechanics: dialog fields, branch-cut-once, one-proposal-per-cycle,
  autoApprove merge path, 3-consecutive-failure stop, persistence/resume,
  completion alert; autonomy boundaries and trajectory sections updated to
  match), `specs/05-ui-design.md` (board mockup, Propose-improvements bullet,
  API surface table, settings section), `specs/10-mobile-first-ui.md` (Active
  section row, overflow-menu label), `specs/00-overview.md` (glossary entry,
  doc-map row), `specs/01-product.md` (self-improvement walkthrough,
  Backlog's "moved by" column — Improvement Run cards are created directly as
  `todo`, never land in Backlog, so PM-pass-as-Backlog-source no longer
  applies), `specs/07-roadmap.md` (backlog item marked shipped-then-superseded,
  matching the existing strikethrough convention), and `specs/03-data-model.md`
  (renamed the `pmPromptTemplate` mention, fixed the `cards.source` note, and
  — since no phase had documented it yet — added the missing `### improvement_runs`
  table section and updated the `events.type` example list to include
  `improvement.*`). Also renamed "PM pass" to "improvement proposer" in
  `src/server/harness/{index,pi}.ts` doc comments and `pi.test.ts` test names
  that used it as the generic example of a `readOnly`, non-pipeline harness
  session, since that example is now stale. `make lint`, `make typecheck`
  (after `rm -rf .next` — a stale `.next/types/validator.ts` from before the
  route deletion was failing typecheck against the now-gone `pm-pass` route
  files), and `make test` (594 passed) all green; `make build` succeeded and
  the route manifest confirms `/api/pm-pass*` is gone and
  `/api/improvement-runs*` is present.
  **Superseded on 2026-07-26 (later session):** the live end-to-end run below
  was executed after all, with the user's explicit go-ahead to spend real
  credits. The paragraph beneath this one describes the earlier decision to
  defer it and is kept for the record.
  Deviation, flagged to the user rather than worked around silently: running
  `make build` while the user's own `npm run dev` was live on port 3000 wrote
  a production build into the shared `.next` directory, which corrupted the
  dev server's runtime state (every route started 500ing). The user chose to
  restart it themselves rather than have me kill their foreground terminal
  process. Separately, the checklist's last bullet ("start a short-budget run
  on a real repo, confirm ≥1 commit lands and the alert fires") was
  **intentionally not executed**: the `verify` skill's own instructions
  explicitly warn against driving a full live loop (orchestrator → harness →
  LLM) as part of routine verification, since it spends real tokens and
  creates real worktrees/commits. Phase 2 made the identical call for the
  identical reason when its own acceptance check came due. The
  create/cut-branch/propose/drive/merge/complete path this bullet wants
  evidence for is covered end-to-end by the existing mocked-orchestrator
  tests in `improvementRuns.test.ts` plus `reviewService`'s merge tests for
  the `baseBranch:featureBranch` path; a real-tokens run is best left to the
  user, whenever they want to spend the budget on it. Plan complete — all six
  phases done.
- 2026-07-26 (later session) — **Live end-to-end verification**, run with the
  user's explicit authorization to spend real credits. `make build` passes and
  the route manifest confirms `/api/improvement-runs*` present, `/api/pm-pass*`
  gone. Two live runs against this repo (openrouter: planner/evaluator
  `z-ai/glm-5.2`, loop `deepseek/deepseek-v4-flash`), both scoped by a Focus
  prompt to a single low-risk test-only change.
  **Run 1 (`ralph/improve-1785129957292`) created zero cards and exposed a
  blocker no unit test could have caught:** `parseProposals` only stripped a
  code fence when the output *started* with one, so the planner's one-sentence
  preamble before its ```json block made `JSON.parse` fail and a perfectly good
  proposal was discarded. The run was on course to end "proposer ran dry" —
  i.e. Improvement Runs would essentially never create a card with this model.
  Fixed in `pm.ts`: `jsonArrayCandidates()` collects fenced blocks then the
  outermost `[…]` span, and `parseProposals` tries each until one parses. The
  first attempt still failed on the real bytes because that proposal's
  *description* literally contained ```` ```json ````, which closes a lazy fence
  match early — hence the try-each-candidate design rather than a single
  extraction. 9 new tests in `pm.test.ts`, two pinned to the exact live shapes.
  Also raised the proposer timeout 5 → 15 min (`improvementProposer.ts`): the
  observed pass took **8m 42s** to settle, so 5 min was set to discard finished
  work.
  **Run 2 (`ralph/improve-1785132626997`) verified the full path**: propose →
  card (`todo`/`agent`/`autoApprove:1`/`baseBranch:featureBranch`, run overrides
  applied) → `startCard` → plan → loop (1 iteration) → evaluate → **evaluator
  approved** → `card.auto_approved` → merge onto the feature branch. The merge
  first failed with `target checkout has uncommitted changes` (my own in-flight
  edits); stashing and `POST /api/cards/:id/retry-merge` landed it with zero
  extra tokens. Branch now carries 5 commits; the second card's worktree was
  cut from the *merge commit*, proving the accumulation property. `GET
  /api/improvement-runs`, the stop route, `improvement.started` /
  `improvement.completed`, and the new `/docs/improvement-runs` wiki page were
  all exercised live.
  **Second bug found and fixed:** a Stop that lands *during* a proposer pass was
  ignored — `driveRun` computed the remaining budget from the `run` snapshot
  taken before the pass, while its own comment claimed it re-read it. Run 2
  spawned a whole extra card **6.5 minutes after** its stopped deadline
  (deadline `06:40:29Z`, card created `06:47:01Z`), burning another pipeline's
  tokens. Now re-reads the row (`getRun(runId)`) before computing
  `remainingMinutes`/`timeoutMinutes`; regression test added that fails against
  the old code.
  Two behaviours documented rather than changed, both in
  `docs/IMPROVEMENT_RUNS.md`: a **dirty working tree fails every merge** at the
  *end* of a card (full pipeline paid for, then Needs Attention) with nothing
  validating it at run creation; and **approved ≠ tidy** — run 2 merged a stray
  8,444-line `pnpm-lock.yaml` (this repo uses npm) alongside its intended
  88-line test change, because the acceptance criteria were about the tests.
  `make build`, `make lint`, `make typecheck`, `make test` (604) all green.
  **Cleanup:** both `ralph/improve-*` branches and the leftover card worktree
  were deleted afterwards at the user's direction, and the tests the runs
  generated were **not** kept — so the branch state described above no longer
  exists on disk (reflog only). What survives from the exercise is what it
  taught us: the two fixes in `626d8bd` and the docs in `9a98f46`. The runs'
  rows are still in `improvement_runs` (both `stopped`, terminal) and their two
  cards are `done`/`abandoned`, so nothing is left driving.
