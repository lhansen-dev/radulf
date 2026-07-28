# 04 — Agent Pipeline

The pipeline is four phases per card: **plan** (one shot), **loop** (many
shots), **evaluate** (independent agent gate), and **review** (human). There
is no separate summarize phase — [14-sandboxing.md](14-sandboxing.md) drops
the summarizer role entirely (it was the most-capable role over the most
untrusted content, for the least essential job) and folds its two jobs into
the evaluator: it writes the card summary into `.ralph/SUMMARY.md` every
run, and on `approve` may also refresh stale docs (an allowlisted set of
paths — see Phase 3 below). All agent work happens inside a git
worktree; all agent I/O is one in-process pi (SDK) session per run whose typed
event stream is normalized straight to transcript files — no subprocess, one
harness for every provider (the SDK runner and normalized event schema live in
[13-single-pi-sdk-harness.md](13-single-pi-sdk-harness.md)).

## Phase 1 — Planning run (frontier)

**Trigger:** user starts the card (Todo → In Progress) and it has no active plan.
**Setup:** orchestrator creates worktree + branch off the repo's default branch.
**Invocation:** one frontier pi (SDK) session in a read-only posture (the
planner's tool set excludes bash/edit/write — it must not modify source; it may
only write into `.ralph/`). Uses the user's pi Claude subscription login.

The planning prompt template (versioned in `src/prompts/plan.md`) instructs the
model to study the repo and the card, then write three files into `.ralph/`:

- **`PLAN.md`** — brief context (goal, key files, risks) plus a `## Tasks`
  markdown checklist that breaks the card into small one-iteration tasks:
  concrete paths, a verify command per task where possible, ordered so each
  builds only on the ones before. The loop ticks items off (`- [ ]` → `- [x]`)
  as it goes, so the checklist's state is the loop's memory.
- **`PROMPT.md`** — the exact Ralph loop prompt (see below). This is the
  planner's most important output: the loop model never sees the card, only
  this file and the repo.
- **`CRITERIA.md`** — a checklist of *mechanically verifiable* acceptance
  criteria (commands to run and their expected outcomes, e.g. "`npx vitest
  run src/health.test.ts` exits 0", "`grep` finds route X"). Test commands
  name only the files relevant to the card — never the full suite. These are
  run exclusively by the evaluator after the loop declares implementation
  complete; they are not loop tasks.

The orchestrator copies all three into the `plans` table (source of truth; the
files in the worktree are the working copies).

- **Normal cards** (`reviewPlanBeforeImplementation = false`): card → `ready`
  (still In Progress on the board, now waiting for a free loop slot).
- **Opted-in cards** (`reviewPlanBeforeImplementation = true`): card →
  `plan_review` (paused, waiting for the user to approve the plan before
  implementation begins). The loop pump is not called for this card; the user
  must explicitly approve via `POST /api/cards/[id]/approve-plan`, which
  transitions the card to `ready` and enqueues the loop.

### PROMPT.md contract

Written by the planner from a skeleton we provide. Required structure:

1. Restate the goal and identify the injected `## Your assigned task` block as
   the loop's only task source. The loop never reads PLAN.md itself.
2. Instruct: do exactly the one assigned task, run its one targeted check, and
   write `.ralph/ITERATION_DONE`. The orchestrator checks off the private
   PLAN.md item and commits the work; if tasks remain, the loop stops and the
   next iteration receives the next item.
3. Completion signal: when `LAST_TASK=true`, after that task's targeted check
   passes, write `.ralph/DONE` with a short bulleted TLDR and stop. The loop
   must not read or run CRITERIA.md. DONE starts the evaluator, which is the
   sole authoritative runner of every whole-card criterion; it does not send
   the card directly to human review.
4. Guardrails: never touch `.ralph/PROMPT.md` or `CRITERIA.md`; never push;
   stay inside this worktree; only run tests covering the current task's
   files — never the full suite (local models burn the whole iteration
   waiting on it). **These guardrails describe the walls, they no longer
   *are* the walls** — [14-sandboxing.md](14-sandboxing.md) enforces the
   worktree boundary, the no-push posture, and the file-access limits at the
   kernel and in-process-tool level regardless of what the prompt says. The
   prompt still states them because a model that knows where the boundary is
   behaves better inside it, but a prompt violation is now a denied syscall
   or a guarded-tool error in the transcript, not a trust failure.

The fresh-context-per-iteration design means the orchestrator-private PLAN.md
checklist + git history *are* the loop's durable memory — this is the heart of
the Ralph pattern. The orchestrator injects the relevant slice of that memory
as one self-contained task. It never overwrites an existing worktree PLAN.md
when (re)starting a run, since its checked state is the progress record.

## Phase 2 — Ralph loop (configured loop provider)

**Trigger:** card is `ready` and the single pipeline slot is free (one ticket
runs at a time — no card is planning, looping, or evaluating). Card → `looping`.

Orchestrator pseudocode:

```
while iterationsDone < maxIterations and elapsed < timeout:
    run one in-process pi (SDK) session (spec 13), cwd=worktree,
        provider=loopProvider, prompt="$(cat .ralph/PROMPT.md)",
        Ralph tool set (bash env scrubbed), reproducible context
    subscribe + normalize transcript → iter-NNN.jsonl; update iterations row live
    if pause requested for this card: finish(exit=completed, reason="paused by user") → card → paused
    if exists .ralph/DONE:            → finish(exit=completed) → card → evaluating
    if process failed 3× in a row:    → finish(exit=failed)
finish(exit=timeout|max-iterations)   → card → needs_attention
```

Details:

- **Pause/Continue:** a user can pause a `looping` task via
  `POST /api/cards/[id]/pause`. The orchestrator records a pause request that
  `runLoop` polls *after* the in-flight iteration finishes (the current
  iteration always completes), then ends the run (`status = completed`,
  `exitReason = "paused by user"`) and moves the card `looping → paused`.
  Resuming (`POST /api/cards/[id]/resume`) moves the card `paused → ready` and
  calls `pump()`, which reuses the existing worktree and checked `PLAN.md`
  (never overwritten) so loop progress is preserved. While paused the card's
  `loopModel` and `evaluatorModel` overrides may be edited via PATCH so resumed
  iterations can run with different models. `paused` is excluded from `pump()`
  (only `ready`) and the planning pump (only `todo`, never `backlog`).

- **Fresh session, fresh context, same prompt** every iteration. No
  conversation continuation (each iteration is a new pi session; no session
  resume).
- The structural skip-permissions posture (pi has no permission system),
  per the classic Ralph loop — no permission prompts, no deny-list the
  model argues with. Containment is kernel-enforced (an OS sandbox on agent
  bash, in-process path guards on the file tools), amended by
  [14-sandboxing.md](14-sandboxing.md); the worktree cwd and prompt
  guardrails (02, Safety posture) remain as defense-in-depth. The worktree
  gets a `CLAUDE.md` note pointing at `.ralph/`.
- An iteration that makes no commit and no `PLAN.md` checklist change counts
  as a **stall**; 3 consecutive stalls end the run early (`exitReason=stalled`)
  — small models can loop politely forever otherwise.
- `.ralph/DONE` is trusted only as a completion signal. The evaluator—not the
  loop—is the sole authoritative runner of CRITERIA.md and independently
  verifies the claims before a human sees the diff. The loop's checks are
  deliberately task-scoped only.

## Phase 3 — Evaluator gate (configured evaluator provider)

**Trigger:** a loop writes `.ralph/DONE` or `.ralph/DONE.md`. The loop run
finishes, the card moves `looping → evaluating`, and an `evaluate` run starts in
the same worktree. This is a mandatory transition; an evaluator crash is never
a pass-through to human review.

The evaluator receives the card title/description and instructions to act as
the sole whole-card verifier:

1. read `.ralph/CRITERIA.md` and the loop's DONE summary;
2. inspect the actual source diff against the loop's recorded base branch;
3. run every command in CRITERIA.md and compare its output to the expected
   result;
4. check for concrete bugs, missed requirements, unrelated changes, and
   unhandled edge cases that the mechanical checks do not cover;
5. write `.ralph/EVALUATION.md` whose first line is exactly
   `VERDICT: approve` or `VERDICT: revise`; and
6. write a brief card summary to `.ralph/SUMMARY.md` (every run), and on
   `approve` only, refresh any stale docs among an allowlisted set of paths
   (`specs/**`, `docs/**`, `README*`, top-level `*.md` — [14-sandboxing.md](14-sandboxing.md)).

**Amended by spec 14:** the evaluator absorbed the deleted summarizer role's
two jobs (writing the summary, updating stale docs), so its integrity check
narrowed accordingly rather than staying an absolute "no non-`.ralph` writes"
rule. The orchestrator snapshots source status and HEAD before invocation and
**still rejects the verdict unconditionally if `HEAD` moved or if any
changed path outside `.ralph/` is not on the doc allowlist** — the
load-bearing guarantee (the judge cannot edit the code it judged to make its
own verdict pass) is unchanged; only doc edits are now permitted, and they
are not independently re-judged — the human diff review is their gate. A
missing/malformed verdict — including a `revise` with no actionable feedback
— fails the run and moves the card to Needs Attention.

Verdict handling:

- **Approve** — finish the evaluation run with `exitReason = "approve"`, commit
  EVALUATION.md (and any doc edits, and the summary) so they travel with the
  branch, and move `evaluating → review`. The review page presents the
  evaluator's note above the diff.
- **Revise** — create plan v(n+1) with an "Evaluator feedback — address this
  first" preamble, append an unchecked evaluator-feedback task to the
  orchestrator-private checklist, finish the evaluation run with
  `exitReason = "revise"`, and move `evaluating → ready`. The next loop
  iteration receives that feedback task explicitly; prose alone is never
  assumed to restart an exhausted checklist.
- **Revision limit** — after two evaluator-requested reloops, a third revise
  verdict advances to human review with the unresolved evaluator feedback shown
prominently. This bounds evaluator/loop ping-pong without hiding the concern.

Evaluation attempts are isolated across reloops: EVALUATION.md is removed before
each evaluator run, so a stale verdict from an earlier attempt can never be
mistaken for the current one. Timeout, provider failure, source mutation, and unexpected exceptions
finish the evaluator run and move the card to Needs Attention. Pulling an
evaluating card back to Backlog aborts the live evaluator controller and
prevents Auto Mode from restarting it.

## Phase 4 — Review (human)

Card sits in In Review only after evaluation, with: full diff (`git diff <mergeBase>...<branch>`,
excluding `.ralph/`), per-iteration transcripts, the plan, CRITERIA.md, and
the DONE summary, plus the evaluator verdict and note.

- **Approve** → orchestrator merges (`--no-ff`, message references the card),
  records the commit sha, prunes worktree + branch, card → Done.
  Merge conflicts (default branch moved since) → card → Needs Attention with
  a "rebase needed" reason; restarting runs a loop iteration whose injected
  first task is the rebase.
- **Reject** → feedback (required) creates plan v(n+1): `PROMPT.md` gains a
  "Reviewer feedback — address this first" section. Card → In Progress
  (`ready`), same worktree, loop resumes on top of existing work.
- **Abandon** → confirm, then prune worktree + branch, card → `abandoned`.
- **Reset** → confirm, then abort any live run, prune every worktree + branch
  for the card, delete its runs (cascading iterations + reviews) and plans, and
  clear its summary/startedAt. Card → `backlog`, so it must be deliberately
  queued before it re-plans from scratch with no leftover progress.

## Failure taxonomy

| Failure | Detection | Card outcome |
|---------|-----------|--------------|
| Planner produced malformed artifacts | missing/empty `.ralph/` files | Needs Attention, replan button |
| Loop provider unreachable (oMLX down, bad OpenRouter key) / model missing | first iteration exits with connection/auth error | Needs Attention, error surfaced, loop not retried |
| Loop stalls | 3 iterations without progress | Needs Attention, `stalled` |
| Caps hit | iteration/timeout counters | Needs Attention, partial work preserved |
| Evaluator missing/malformed verdict | EVALUATION.md parser rejects output | Needs Attention; never forwarded to review |
| Evaluator changes source/history | HEAD moved, or a changed non-`.ralph` path is not on the doc allowlist | Needs Attention; verdict rejected |
| Evaluator requests changes | `VERDICT: revise` with actionable feedback | Plan v(n+1), feedback task, loop resumes; human escalation after bounded retries |
| Server restart mid-run | boot recovery finds `running` rows | Needs Attention, `interrupted`, worktree preserved |
| False DONE (criteria not really met) | evaluator runs checks/reads diff, then human reviews | Evaluator revise or human reject → loop resumes |

## Provider failures — fail loudly, no fallback

There is **no automatic provider fallback**. The `shouldFallback` /
`agentFallback` / `pickReachableProvider` machinery and its Settings keys were
deleted (feedback.md #6): they hand-rolled the "try primary, clear artifacts,
re-run on a secondary" dance four times and violated the project's one-code-path
rule. When a provider fails — connection/DNS failure, timeout, auth failure
(401/403), or rate/usage-limit throttling (429/529) — the run lands in **Needs
Attention** with the error surfaced, and the user retries (optionally after
editing the card's per-role provider/model overrides). Failing loudly is the
deliberate posture.

## Verification note

The oMLX integration (used only when oMLX is the configured provider) is a pi
`models.json` custom-provider block (`anthropic-messages`, with
`openai-completions` the documented fallback) against the oMLX server —
revalidate against [13's checklist](13-single-pi-sdk-harness.md) after oMLX or
pi SDK upgrades. The walkthrough in 07 is the standing smoke test: one
hand-written card through plan → loop → evaluate → diff.
