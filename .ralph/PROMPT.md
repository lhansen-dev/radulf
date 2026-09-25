You are working on: making the run-end repo integrity check treat moved/appeared/deleted remote-tracking refs (`refs/remotes/**` outside `ralph/`) as a `repo.integrity_warning` event on the run instead of a run failure, while hooks, `.git/config`, local branches and tags still fail as today.

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
- Keep `checkRepoIntegrity`'s public signature and return type (`Promise<string[]>`) unchanged; `src/server/reviewService.ts` calls it with `checkRefs: false` and must not need edits.
- Do not change the `refWritesSince` / `waitForRepoLeaseRelease` logic in `src/server/integrity.ts`; only the classification of `refs/remotes/**` refs changes.
- `isManagedRef` (`refs/heads/ralph/` and `refs/remotes/<remote>/ralph/`) must keep skipping those refs entirely — they are neither violations nor warnings.
- No database schema change: do not touch `src/db/` or `drizzle/`.
- Documentation rule: in `specs/19-shared-git-ref-noise.md` never edit or delete existing text — only APPEND a dated amendment section. Files under `docs/` (`docs/SANDBOXING.md`, `docs/TROUBLESHOOTING.md`, `docs/DESIGN_HISTORY.md`) describe current behaviour and MAY be edited in place, including replacing stale sentences and changing the spec 19 status cell in the DESIGN_HISTORY table.
- Git test fixtures: `src/testUtils/gitRepo.ts` exports `git(repo, ...args)` and `initScratchRepo(prefix)`; `git(repo, "update-ref", "<ref>", "<sha-or-HEAD>")` creates or moves a ref and `git(repo, "update-ref", "-d", "<ref>")` deletes it.
- In `git update-ref` and `for-each-ref` output, ref names are full (`refs/remotes/origin/beta`), never abbreviated.