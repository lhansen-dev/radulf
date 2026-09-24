You are working on: running Radulf's background work (improvement-run drivers, the schedule tick, the retention sweep) safely under several worker processes via database leases and compare-and-set markers, splitting compose.yaml into `web` and `worker` services, and rewriting docs/ARCHITECTURE.md, docs/DOCKER.md and docs/SANDBOXING.md to match (spec 25 decisions 7 and 11).

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
- Never edit anything under `specs/`; `docs/` is rewritten to describe the present.
- Existing patterns to copy: `src/server/repoLeases.ts` and `src/server/repoLeases.test.ts` (lease + stale takeover), `src/server/workers.ts` (`liveWorkerIds`, `staleBefore`, `HEARTBEAT_INTERVAL_MS`), and the `db.transaction(fn, { behavior: "immediate" })` shape used in `src/server/reviewService.ts`.
- Tests use `setupTestDataDir("radulf-<name>-")` from `@/testUtils/testDataDir` BEFORE `await import("@/db")`; copy the top of `src/server/repoLeases.test.ts`.
- `src/server/boot.test.ts` and `src/server/improvementRuns.test.ts` mock modules with fixed export lists; when you add an export that boot.ts / improvementRuns.ts uses, add it to the mock too.
- Do not set or override `TMPDIR`; `/tmp` is read-only here. Never run `make test`, `make check`, or a bare `vitest run` — only the test files named in your task.
- Docker is not available here: verify compose.yaml / Dockerfile / Makefile changes with the grep and `make -n` checks in the task, not by running containers.