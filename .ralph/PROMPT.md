You are working on: Fan out events and live transcripts to every Radulf process — an events tailer that polls the `events` table and re-emits on the local bus (skipping locally emitted ids), and a web-owned per-running-run transcript watcher registry, so split web/worker processes see every event and every live transcript (spec 25, decision 5).

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
- Read the files the task names just in time (`src/server/events.ts`,
  `src/server/transcript.ts`, `src/server/boot.ts`, `src/server/boot.test.ts`,
  `src/server/splitProcesses.test.ts`, `src/testUtils/testDataDir.ts`) and copy
  the conventions you see there: `@/db` imports, globalThis-backed singletons
  (`__radulf...`), drizzle queries (`eq`, `gt`, `desc`, `asc`, `sql` from
  `drizzle-orm`), `vi.spyOn(fs, "watch")` mocking as in `transcript.test.ts`.
- Tests that touch the database must call `setupTestDataDir(prefix)` at module
  top BEFORE `await import("@/db")`; temp paths come from `os.tmpdir()`. Never
  write to a literal `/tmp`, never override `TMPDIR`, never put temp dirs inside
  the worktree.
- The tailer and the watcher registry must write nothing to the database.
- Do not change anything under `src/app/ui` or `src/app/card`, and leave
  `src/server/scoping.ts` alone.
- Run only the check named in your task. `make check-split` builds and spawns
  real processes and takes minutes; run it at most once per iteration.
