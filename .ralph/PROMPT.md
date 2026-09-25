You are working on: persisting a Jira issue key on cards (`cards.jira_key`), linking it on the card page, and — behind the opt-in `jiraCommentOnDone` setting — posting exactly one bounded, never-blocking plain-text comment on that issue when the card reaches Done (review merge, PR delivery, epic parent closing), recorded as `jira.commented` / `jira.comment_failed` events.

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
- There is NO network. Never run `npm ci`, `npm install`, or anything that
  downloads. If `node_modules` is missing, copy it once from the registered
  checkout (a real copy, NEVER a symlink — a symlinked `node_modules` breaks
  the production build):
  `[ -d node_modules ] || cp -al /repos/radulf/node_modules node_modules 2>/dev/null || cp -a /repos/radulf/node_modules node_modules`
  `node_modules` is gitignored, so it never shows in `git status`.
- Run tools from the local binaries: `npx vitest run <file>` resolves
  `node_modules/.bin/vitest` without network; `node_modules/.bin/drizzle-kit generate`
  is offline. Test files whose path contains `[id]` must be quoted.
- Code style: TypeScript, 2-space indent, double quotes, trailing commas; tests
  use vitest (`describe/it/expect/vi`). Server tests call
  `setupTestDataDir("...")` BEFORE any `await import("@/db")`.
- Never log or echo `jiraApiToken` or an `Authorization` header. Keep
  `jiraApiToken` in `SECRET_SETTINGS` and leave the `jiraBaseUrl` validation
  branch in `src/server/settings.ts` untouched.
- `announceCardDone` must never throw and must never block a card transition;
  Jira failures become `jira.comment_failed` events only.
