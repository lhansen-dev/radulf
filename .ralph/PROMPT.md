You are working on: moving review delivery (approve / retry-merge) out of the web process into workers that claim a durable `review_deliveries` row under a per-repo `repo_leases` row, record moved refs in a `ref_writes` table that the run-end integrity check consults, and are reaped when their worker dies (spec 25 decision 6 in `specs/25-web-and-worker-processes.md`).

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
- Tests open SQLite against a throwaway data dir via `setupTestDataDir(...)` from `@/testUtils/testDataDir` and then `await import("@/db")`; the DB migrates itself from `drizzle/` on open, so a new table is usable in tests once its migration exists. Never set TMPDIR yourself and never point temp dirs inside the worktree (`/tmp` is read-only here; the environment's TMPDIR is already correct).
- Drizzle idioms used here: `db.transaction((tx) => {...}, { behavior: "immediate" })`, `.onConflictDoUpdate({ target, set })`, `.run().changes`, `.get()`, `.all()`; `now()` from `@/db` returns an ISO timestamp; `getSettings().workerStaleSeconds` is the stale window; `liveWorkerIds(staleSeconds)` lives in `src/server/workers.ts`.
- The merge and pull-request code paths in `reviewService.ts` / `git.ts` must not change in behaviour — only who runs them and how they are serialized.
- Run only the vitest files named in your task (e.g. `npx vitest run src/server/foo.test.ts`); `npx tsc --noEmit` is fine when the task asks for it.
