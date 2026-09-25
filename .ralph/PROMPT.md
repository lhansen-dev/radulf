You are working on: running a plan's acceptance check commands against the untouched worktree before the loop starts (an `acceptance.precheck` event, one bounded replan for checks that already pass, no repair iteration for such checks after DONE, and a `## Regression` marking that skips the pre-check), with cancellation-safe planning.

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

Hints for this repository:
- TypeScript + Next.js + vitest + drizzle/sqlite. Tests that touch `@/db` import it after `setupTestDataDir` (see the top of `src/server/planningService.test.ts`) — follow the existing pattern in whichever test file you edit.
- Read the code you are changing first (grep, then read the exact ranges); the existing acceptance probe is in `src/server/acceptanceProbe.ts`, the planning run in `src/server/planningService.ts`, the critic's revision cap in `src/server/planCriticService.ts`, and the post-DONE probe call in `src/server/orchestrator.ts` near `runAcceptanceProbe`.
- The probe is one-sided by design: a zero exit proves nothing about a criterion. The pre-check uses that fact the other way round (a check that already passes cannot show new work) and must never be described as a correctness check of the plan. Do not widen `PROBE_ALLOWED` or relax `SHELL_METACHARACTER`.
- Run only the single check named in your task. Do not run `make check` or the whole vitest suite.