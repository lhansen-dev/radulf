You are working on: making this repository's test suite runnable inside Radulf's own sandbox (no literal `/tmp` filesystem paths in tests, real-sandbox tests skip themselves when nested, and the sandboxed `TMPDIR` becomes the run-private directory via `CLAUDE_CODE_TMPDIR`).

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
- If `node_modules/.bin/vitest` does not exist, run `npm ci` once before your check (the npm registry is reachable). Never run `make test` or a bare `vitest run`.
- Never set or override `TMPDIR`, and never point a temp directory inside this worktree. Use whatever the environment already provides; `os.tmpdir()` in Node honours it.
- You are yourself running inside Radulf's sandbox: `/tmp` is read-only and real bubblewrap/Seatbelt suites cannot start here. When a check on `src/server/sandbox/srt.test.ts` reports the real-runtime suites as skipped, that is the expected result here, not a failure.
- Use the `Edit` tool with exact, minimal `oldText` snippets; keep surrounding code and comments intact.