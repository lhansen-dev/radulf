# 06 — Self-Improvement

Radulf improving Radulf is the same pipeline pointed at this repo — no
special code path for execution, no background autonomy. In v1 everything is
**user-initiated**: the user writes (or requests) improvement cards, starts
them, and either approves each merge or opts into auto-approve for a batch
(as an Improvement Run does). Crons/scheduling are deliberately out of scope
— and are themselves a natural future card for Radulf to build into itself.

## Two ways to feed the board

### 1. User-written cards

Register the radulf repo like any other, write a card, and press **Start**.
Nothing more to it.

### 2. Improvement Runs — the "Start improvement run" button

**Implemented** — routes under `src/app/api/improvement-runs/`, driver in
`src/server/improvementRuns.ts`, proposer in `src/server/improvementProposer.ts`,
prompt at `src/prompts/improve.md`, dialog + board banner in
`src/app/ui/improvementRunDialog.tsx` / `src/app/page.tsx`.

A user-triggered, self-driving loop against a registered repo — Radulf's own
repo being the expected first target. From the **Start improvement run**
dialog the user picks a repo, base branch, optional focus prompt, a time
budget, and optional model/reasoning/iteration/timeout overrides, then
`POST /api/improvement-runs` creates the run:

1. A feature branch `ralph/improve-<ts>` is cut off the chosen base branch
   once, up front, and recorded on the run.
2. The driver loop repeats until the time budget is spent: it proposes
   exactly **one** improvement (reusing the PM prompt's `parseProposals`
   plumbing against an ephemeral worktree checked out at the feature
   branch's tip, so each proposal sees everything accumulated so far), then
   creates a card for it (`autoApprove: true`, `baseBranch: featureBranch`)
   and drives it through the normal pipeline itself via `startCard` —
   independent of the global Auto Mode toggle and never interleaved with the
   user's other Queue cards.
3. An approved card merges straight into the feature branch (no new merge
   code — this is the same `baseBranch` merge path every other card uses). A
   rejected or failed card is left as `needs_attention` for the human; the
   run counts consecutive failures and stops after **3** in a row so a bad
   run doesn't burn the whole budget.
4. The feature branch is never deleted automatically — it is the
   deliverable, left for human review like any other branch of cards.

Dedup guard: the proposer prompt is given the titles of every improvement
already created this run (`{{EXISTING_CARDS}}`) so it won't repeat itself.

While a run is active it appears as a live row on the Work board — feature
branch name, countdown to the run's deadline, tasks succeeded, the
in-flight card's title, and a **Stop** button (soft-stops between tasks; a
task already in flight always finishes). Run state is persisted in the
`improvement_runs` table, so a server restart resumes an in-flight run
rather than silently killing it. Finishing (or stopping) a run fires a
completion alert naming the feature branch and the number of tasks landed.

## Self-hosting mechanics (Radulf targeting Radulf)

The loop edits a **worktree** of the radulf repo, so the running app's
checkout is untouched until Approve. Specific rules:

- **Merge ≠ deploy.** Approving a radulf card merges to `main`; the running
  server keeps serving old code until it reloads (`npm run dev` picks up
  changes automatically — acceptable for v1; a "restart to apply" banner
  appears after a self-merge).
- **The DB is not the repo's.** `data/` is gitignored and lives outside
  worktrees, so loops can't corrupt live state. Schema migrations authored by
  a loop run on next boot via Drizzle migrations — migration files get extra
  reviewer attention (the Review UI flags changes under `drizzle/`).
- **Criteria must include the build.** The plan skeleton for the radulf repo
  demands `npm run build` and `npm test` in CRITERIA.md. The evaluator—not the
  loop—runs those whole-card commands before a self-improvement card can reach
  In Review, and the reviewer can re-run them if they doubt the result.
- **specs/ are load-bearing.** The improvement proposer and planners read
  `specs/` as ground truth. Cards that change behavior should update the
  relevant spec in the same diff; the proposer prompt is told to propose
  spec-sync cards when code and specs drift.

## Autonomy boundaries (hard rules)

1. No merge without a `reviews.decision = approved`. No setting exists to
   bypass this — an auto-approved card still merges through the same review
   path, just without waiting on a human.
2. Nothing starts without a user action: cards are started explicitly, an
   Improvement Run by button. No crons in v1.
3. Loop agents never run against the user's live checkout, never `git push`,
   never touch `data/`.
4. An Improvement Run's proposer may propose changes to prompts or
   orchestrator code, but such diffs are flagged in Review (changes under
   `src/prompts/` or orchestrator modules get a "self-modifying" banner) —
   the human should read these closest, review-gated or not.
5. Caps (per-task iterations, per-task timeout, one proposal per cycle, a
   run-level time budget, and a 3-consecutive-failure stop) are enforced by
   the orchestrator/driver, not by prompt politeness.

## Trajectory

Crawl: user writes cards against radulf and works the board manually.
Walk: an Improvement Run self-drives a time-boxed batch of auto-approved
changes onto one feature branch; the user reviews the accumulated branch
after the fact rather than curating each proposal up front.
Run (post-v1, each step an explicit user decision): scheduled Improvement
Runs (the cron feature built *by* a card) and a quality feedback loop
(rejection feedback mined to improve `src/prompts/*`).
