You are working on: making the run-end repo integrity check treat moved, new or deleted remote-tracking refs (`refs/remotes/**` outside the `ralph/` namespace) as a `repo.integrity_warning` event on the run instead of a run failure, while local branches, tags, hooks and `.git/config` still fail exactly as today.

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
- TypeScript project; tests run with vitest (`npx vitest run <file>`), types with `npx tsc --noEmit`. Read the exact code you are changing (grep first) before editing; the task text names files and symbols.
- The integrity check lives in `src/server/integrity.ts`; the run-end call site is `integrityViolationReason` in `src/server/stage.ts`; events are written with `emitEvent(type, { cardId, runId, payload })` from `src/server/events.ts`.
- Test git repos: `src/testUtils/gitRepo.ts` exports `initScratchRepo(prefix)` and `git(dir, ...args)`. `git update-ref <ref> <oid>` creates or moves a ref; `git update-ref -d <ref>` deletes it; `git commit-tree <tree> -p HEAD -m msg` mints a new commit oid without moving any branch.
- Keep the spec 25 `refWritesSince` / `waitForRepoLeaseRelease` logic in `checkRepoIntegrity` exactly as it is; only the classification of `refs/remotes/**` changes. Do not touch `src/server/reviewService.ts` or the database schema.
- When editing spec/doc files, add text; never rewrite or delete the original wording.
