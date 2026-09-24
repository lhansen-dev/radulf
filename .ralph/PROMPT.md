You are working on: spec 29 — when a loop signals DONE, the orchestrator merges the base branch into the worktree and runs the repository gate before evaluation, handing conflicts and gate failures back to the loop as tasks (bounded to two rounds).

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

Hints for this card:
- This repository is TypeScript (Next.js + vitest). Run checks with `npx vitest run <file>` exactly as the task names them; never `make check` or a bare `npx vitest run`.
- The spec number for this card is 29. Never write "28" anywhere; spec 28 belongs to another card.
- Read the code you change just in time: `src/server/orchestrator.ts` (`runLoop`, the `if (doneFilePath(ralphDir))` block around the acceptance probe), `src/server/gate.ts`, `src/server/git.ts` (`tryGit`), `src/server/checklist.ts` (`appendTask`), `src/server/evaluationService.ts`, `src/server/harness/mock.ts`, `src/server/mockPipeline.test.ts`, `src/server/orchestrator.lifecycle.test.ts`.
- Do not change any file under `src/server/harness/` other than `mock.ts`, and never change `src/server/reviewService.ts`.
- Do not set or override `TMPDIR`; tests that need temp dirs use `os.tmpdir()` or `@/testUtils/gitRepo`.
- In `src/server/orchestrator.ts`, file reads/writes use the `/* turbopackIgnore: true */` comment before the path argument, e.g. `fs.readFileSync(/* turbopackIgnore: true */ planPath, "utf8")`; follow the existing style.