You are working on: running a plan's acceptance check commands against the untouched worktree before the loop starts (spec 31), so a new-behavior check that already passes is sent back to the planner once and never buys a post-DONE repair iteration.

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
- The probe is one-sided by design (`src/server/acceptanceProbe.ts` header comment): a zero exit proves nothing about a criterion. The pre-check uses the same fact the other way round — a check that already exits the way its criterion expects on the untouched tree cannot prove new work. Never describe or implement it as a correctness check of the plan.
- Do not widen `PROBE_ALLOWED` or relax `SHELL_METACHARACTER` in `src/server/acceptanceProbe.ts`.
- Under `sh -c`, a missing command exits 127 (a numeric code); treat it, timeouts (`killed`), and non-numeric codes as unprobed — never as a criterion result.
- Tests in `src/server/planningService.test.ts`, `src/server/planCriticService.test.ts`, and `src/server/orchestrator.lifecycle.test.ts` use `vi.mock` for `./harness` and `./git` and a per-file test data dir; follow the neighbouring tests' patterns for seeding `cards`, `plans`, and `runs`. Mock pipeline scenarios live in `src/server/harness/mock.ts`.
- When a task asks for a migration, run `npx drizzle-kit generate` from the repo root; do not hand-edit `drizzle/meta/*`.
