You are working on: running a plan's acceptance check commands against the untouched worktree before the loop starts (an `acceptance.precheck` event, one bounded planner revise, a `## Regression` marking, and no post-DONE repair for checks that already passed), in the Radulf orchestrator (TypeScript, vitest).

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
- Before editing, read the relevant parts of `src/server/acceptanceProbe.ts`,
  `src/server/planningService.ts`, `src/server/planCriticService.ts` and the
  matching `*.test.ts` file so new code matches the existing style (comments
  explain WHY; drizzle queries via `db`, `runs`, `plans` from `@/db`).
- Never widen `PROBE_ALLOWED` or relax `SHELL_METACHARACTER` in
  `src/server/acceptanceProbe.ts`; the pre-check runs only what
  `probeCommands` returns, through the same prefix/sandbox path as the probe.
- The pre-check is one-sided like the probe: a check that already exits 0 on
  the untouched tree proves nothing; do not describe it as a plan correctness check.
- Tests that reach `@/db` import it after `setupTestDataDir(...)` with
  `await import(...)`, as the existing test files do. Use `vi.fn()` and
  deferred promises for deterministic cancellation/timeout tests; never rely
  on wall-clock timing.
- Run only the single vitest file or `-t` pattern named in your task.
