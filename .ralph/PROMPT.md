You are working on: letting an epic's pieces declare `dependsOn` sibling dependencies and adding a third epic run mode, `graph`, that starts a piece once every dependency is Done or Abandoned (spec 28, amending spec 24), in the Radulf Next.js + SQLite (drizzle) codebase.

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
- Tests are vitest: `npx vitest run <file>` or `npx vitest run <file> -t "<name>"`. Never `make test`, never bare `npx vitest run`. React component tests live beside their component (`*.test.tsx`, jsdom) and can be named by basename, e.g. `npx vitest run breakdownEditor.test.tsx`.
- Do not set or override `TMPDIR`; the sandbox provides one. Never point temp dirs inside the worktree.
- Server tests use `setupTestDataDir(...)` from `@/testUtils/testDataDir` and then `await import("@/db")` — follow the pattern already in the test file you are editing. The DB migrates itself from `drizzle/` on open, so a new column needs its migration file before any DB test will see it.
- Epic run modes live in `src/shared/epics.ts` (`EPIC_RUN_MODES`); epic helpers in `src/server/epics.ts`; the scheduler is `pump()` in `src/server/orchestrator.ts`; breakdown request validation is `parseBreakdown` in `src/server/cardValidation.ts`.
- Keep `ordered` and `parallel` behaviour exactly as it is — existing epic tests must pass unchanged. Only the docs task may touch `specs/`.
- Import paths use the `@/` alias for `src/` (e.g. `@/shared/epics`, `@/db`).