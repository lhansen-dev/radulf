You are working on: making Radulf's own test suite pass when run nested inside Radulf's sandbox — this iteration fixes `src/server/evaluationService.test.ts` leaking a queued `runHarness` mock when the Phase 18.1 sandbox test cannot start a nested sandbox, by sharing the `insideRadulfSandbox` predicate from `src/testUtils/` (test files and test utilities only; no production code).

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
- Run vitest as `node_modules/.bin/vitest run <file>`. Never set or override
  `TMPDIR`; leave it exactly as the environment provides it, and never point it
  inside this worktree.
- The `@/testUtils/...` import alias already works (see the existing
  `import { setupTestDataDir } from "@/testUtils/testDataDir";`). Files under
  `src/testUtils/` that do not end in `.test.ts` are not collected as tests.
- Inside Radulf's sandbox it is normal for `src/server/sandbox/srt.test.ts` to
  report 21 skipped tests and for the Phase 18.1 test in
  `src/server/evaluationService.test.ts` to be skipped; a skipped test is not a
  failure. Only a non-zero exit code is a failure.
- `vi.clearAllMocks()` does NOT drop a pending `mockImplementationOnce` /
  `mockResolvedValueOnce`; `mock.mockReset()` does, but it also removes the
  default implementation, so call `mockReset()` BEFORE re-establishing
  `mockResolvedValue(...)`, never after.
- Only edit the files the task names. Do not touch anything under
  `src/server/sandbox/srt.ts` or any other non-test source file.