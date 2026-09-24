You are working on: replacing the orchestrator's in-memory start guards and single-process boot recovery with database claims (`BEGIN IMMEDIATE`), a `workers` table with heartbeats, `runs.worker_id`, and a continuous stale reaper, so two worker processes can share one SQLite database.

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

Task-specific hints:
- Environment: `/tmp` is read-only here and `TMPDIR` is already set. Never set or override `TMPDIR`, and never point temp files inside the worktree.
- `src/server/harness/` and `src/server/sandbox/` must not change. Only import from them.
- Database access is drizzle over better-sqlite3 (`import { db, now, cards, runs, workers, ... } from "@/db"`). `db.transaction(fn, { behavior: "immediate" })` opens `BEGIN IMMEDIATE`; every `db` statement inside `fn` runs in that transaction.
- Generate migrations only with `make db-generate` (drizzle-kit); never hand-write files under `drizzle/`.
- Test files that touch the database call `setupTestDataDir(...)` from `@/testUtils/testDataDir` at top level BEFORE `await import("@/db")` — copy the pattern in `src/server/orchestrator.roles.test.ts` or `src/server/orchestrator.lifecycle.test.ts`.
- `src/server/orchestrator.lifecycle.test.ts` has helpers `card(...)`, `plan(...)`, `completedRun(...)`, `getCard(...)`, `getRun(...)`, `settle()`, `successfulHarnessResult`, and `mocks.settings` for per-test settings overrides; read the helper definitions near the top of the file before adding tests.
- Run only the targeted vitest command named in your task (`npx vitest run <file> [-t "<pattern>"]`). The split-process check (`RADULF_SPLIT_CHECK=1 npx vitest run src/server/splitProcesses.test.ts`) spawns real processes and is slow — run it only when your task names it.
