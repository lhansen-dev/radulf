You are working on: fixing reviewer feedback on the database-claims / worker-heartbeat / stale-reaper implementation in the Radulf orchestrator (`src/server/orchestrator.ts`, `src/server/workers.ts` and their tests) without reintroducing any in-memory card bookkeeping.

Your task for this iteration is given in the `## Your assigned task` block at
the top of this prompt, together with a LAST_TASK=true|false flag. That block
is your ONLY task source — there is no task list to find or update; the
orchestrator tracks completion and makes all commits.

Do exactly that ONE task this iteration — nothing else:
1. Do the task. Verify it worked: run the check named in the task (if any)
   and confirm `git status` shows the files you edited. Never claim a task
   whose edits you did not make in THIS session — the orchestrator rejects
   completions that changed nothing.
2. Write a short summary (one or two lines) of what you did into
   `.ralph/ITERATION_DONE` — this signals the orchestrator to record
   completion and commit your work.
3. If LAST_TASK=false, STOP NOW. Do not start anything else — the next
   iteration will handle it.

Only if LAST_TASK=true: after your task-specific check passes and you write
`.ralph/ITERATION_DONE`, write a short bulleted TLDR into `.ralph/DONE` (a
one-line header summarizing the change, followed by a few `- ` bullets
covering what changed, why, and key files) and stop. Whole-card acceptance
testing is the evaluator's job, not yours. Never write `.ralph/DONE` if the
task-specific check failed or when LAST_TASK=false.

Rules: never run `git add`, `git commit`, `git checkout`, `git switch`,
`git push`, or any other git command that changes state. The orchestrator
commits for you, and the worktree must stay on the branch it was given.
Read-only commands like `git status` and `git diff` are fine. Never modify
`.ralph/PROMPT.md`; never touch files outside this working directory; only run
tests that cover your current task's files — NEVER run the full test suite.
Your assigned task is the ONLY task: never create or update any harness
todo list (e.g. the todowrite tool).
Batch independent reads/searches into a single turn instead of issuing
them sequentially.
Do not re-read a file after editing it unless a check fails or the edit tool
reports ambiguity.

Hints for this codebase:
- Never set or override `TMPDIR`; it is preset by the sandbox. Never create temp files inside the worktree.
- `src/server/harness/` and `src/server/sandbox/` must not change.
- Do not add back any in-memory Set/Map of card ids to `Orchestrator`; the database (`cards.status`, `cards.evaluation_pending`, `runs.worker_id`, `workers`) is the only shared state. The removed field names must not appear in `src/server/orchestrator.ts`, not even in comments.
- Drizzle transactions with `BEGIN IMMEDIATE` are written `db.transaction((tx) => { ... }, { behavior: "immediate" })`; look at the existing `claimPendingEvaluation` in `src/server/orchestrator.ts` for the exact shape.
- Test files import from `@/db` after `setupTestDataDir(...)` via `await import(...)`; follow the existing imports in the file you edit. Run only the vitest command named in your task.
- If a vitest run fails with an error about `/tmp/...` being read-only or missing, that is environmental — report it in `.ralph/ITERATION_DONE` only if your own check could not run at all; do not work around it by changing `TMPDIR`.