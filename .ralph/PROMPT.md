You are working on: persisting a card's Jira issue key (`cards.jira_key`), linking it on the card page, and — behind the opt-in `jiraCommentOnDone` setting — posting exactly one plain-text comment on the Jira issue when the card reaches Done, without ever blocking the card.

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

Environment hints:
- This sandbox has NO network. Never run `npm ci`, `npm install`, or `npx`.
  Dependencies come from the registered checkout by a real copy (never a
  symlink — a symlinked `node_modules` breaks the production build). Before
  running any check, if `test -x node_modules/.bin/vitest && test -x node_modules/.bin/drizzle-kit`
  fails, run exactly: `rm -rf node_modules && mkdir -p node_modules && cp -a /repos/radulf/node_modules/. node_modules/`
  and re-run that test. If it still fails, stop, describe the failure in
  `.ralph/ITERATION_DONE`, and do not claim the task.
- Run tools as `node_modules/.bin/vitest run <file>`, `node_modules/.bin/tsc --noEmit`,
  `node_modules/.bin/drizzle-kit generate --name <name>` (offline).
- Tests that emit card-scoped events must seed a repo and a card first:
  `events.card_id` has a foreign key. Put new tests inside the existing
  `describe` whose `beforeEach` seeds and cleans, or extract shared setup.
- Restore anything you stub: `vi.unstubAllGlobals()` for `fetch`, and put
  `process.env.*` back to its previous value in `afterEach`.
- Never log or assert-print the Jira API token or the Authorization header
  value outside a test's own expectation.
- In TypeScript, `a ?? b || c` is a syntax error; write `a ?? (b || c)`.