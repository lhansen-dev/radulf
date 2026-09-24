You are working on: replacing the orchestrator's in-memory start/pause/pending-evaluation state with database claims (`BEGIN IMMEDIATE`), worker heartbeats in a `workers` table, and a continuous stale reaper, so two worker processes can share one SQLite database (spec 25, decisions 2 and 3).

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
- Never set or override `TMPDIR`; the sandbox presets a writable one. Never
  point temp files inside the worktree.
- `src/server/harness/` and `src/server/sandbox/` must not change.
- The schema (`workers` table, `runs.worker_id`, `cards.evaluation_pending`),
  the migration `drizzle/0018_*.sql`, and the `workerStaleSeconds` setting
  already exist on this branch — do not regenerate or redo them.
- Drizzle's better-sqlite3 driver opens `BEGIN IMMEDIATE` with
  `db.transaction((tx) => { ... }, { behavior: "immediate" })`; statements
  inside must use `tx`, and the callback's return value is the transaction's.
- `src/server/orchestrator.roles.test.ts` is the template for a small
  DB-backed orchestrator test: `setupTestDataDir(...)`, a `vi.mock("./settings")`
  built from `SETTING_DEFAULTS`, then `await import("@/db")` and
  `await import("./orchestrator")`.
- Run only the check named in your task. If it fails for a reason clearly
  unrelated to your edit (a `/tmp` literal path, a nested sandbox runtime),
  say so in `.ralph/ITERATION_DONE` rather than chasing it.
