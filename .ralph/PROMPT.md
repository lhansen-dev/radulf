You are working on: Radulf — boot `web` and `worker` process roles (selected by `RADULF_ROLES`, default both) from one boot module outside Next.js, with a plain Node worker entry point, concurrency-safe migrations and auth-secret creation, and a two-process check run from `make`.

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

Project hints:
- This is a Next.js 16 + TypeScript repo; the Makefile is the single source
  of truth for tooling (no package.json scripts). `make` puts
  `node_modules/.bin` on PATH; for a single test file `npx vitest run <file>`
  (or `node_modules/.bin/vitest run <file>`) is the right targeted check.
- Nothing under `src/server/**`, `src/db/**`, or `src/worker.ts` may import
  from `next`. Do not modify `src/server/harness/**`, `src/server/sandbox/**`,
  `Dockerfile`, `compose.yaml`, or the `dev` / `start` Make targets.
- Existing tests build orchestrators with `new Orchestrator({ autoStart: false })`
  and must keep working unchanged; new behaviour goes behind new options/roles.
- Match the existing style: 2-space indent, double quotes, trailing commas,
  comments that explain *why*. Read the file you are about to edit first; grep
  for the exact names the task mentions rather than guessing signatures.
- Test files that need the database call `setupTestDataDir(...)` from
  `@/testUtils/testDataDir` at module top level and then `await import("@/db")`
  — copy the pattern from the scaffold the task points you at.
