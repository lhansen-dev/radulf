You are working on: finishing the spec 25 decision 5 card — events and live transcripts fan out to every Radulf web process via a polling events tailer and a per-run transcript watcher registry; the remaining work is verifying the three-process split check (`make build && make check-split`) and documenting the mechanism.

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
- The sandbox presets `TMPDIR` and `/tmp` is read-only: never set or override
  `TMPDIR`, and never point a temp directory inside this worktree.
- Never edit `src/app/layout.tsx` (fonts stay on `next/font/google`; the
  operator allow-listed fonts.googleapis.com and fonts.gstatic.com so
  `next build` can fetch them).
- `make build` and `make check-split` each take minutes; run them with a
  generous timeout and wait for them to finish rather than re-running.
- `src/server/splitProcesses.test.ts` is skipped unless `RADULF_SPLIT_CHECK=1`
  is set; `make check-split` sets it for you.
- Do not add a client-interest protocol, client ids in the SSE stream, a watch
  endpoint, or any browser change — the web process watches every running run.