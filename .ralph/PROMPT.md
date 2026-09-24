You are working on: finishing the plan critic stage (spec 30) by fixing the reviewer's findings — remove the "Numbered 30 because 28…" paragraph from the spec, add the critic fields to the request-validation test's expected object, map `critique` runs to `critique.jsonl` in the runs API route with a route test, and name the plan critic in stage diagnoses.

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

Hints:
- The critic implementation already exists and works; your task is a small, precisely located fix. Do not refactor or re-implement anything beyond what the task names.
- Paths containing `[id]` must be quoted in shell commands, e.g. `npx vitest run 'src/app/api/runs/\[id\]/runRoute.test.ts'`.
- Never write to a literal `/tmp` path and never set `TMPDIR`; tests get temp dirs from `setupTestStateDir` / `os.tmpdir()`.
- `grep -c` printing `0` exits with status 1 — for the spec task that is the expected success outcome.
