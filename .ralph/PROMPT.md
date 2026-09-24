## Merge conflict — resolve this first

Your branch conflicts with `beta`, which changed while you worked. `beta` has been merged into your branch and the conflicted files now contain `<<<<<<<` / `=======` / `>>>>>>>` markers. Resolve every marker (keep both your work and the base's intent), remove the markers, and write the normal completion signals so the orchestrator can record the merge. Only once the working tree is clean, finish the task and write DONE as usual.

---

You are working on: making the spec 29 base sync in `src/server/orchestrator.ts` wait for the per-repo delivery lease to be free (never acquire it) and correcting two sentences in `specs/29-sync-and-gate-before-evaluation.md` to match.

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
- The repository already contains a working spec 29 implementation (`src/server/baseSync.ts`, `src/server/gate.ts`, the mock `base-conflict` scenario, tests). Only change exactly what your assigned task names; do not refactor, rename, or "improve" anything nearby, and never edit `src/server/harness/`, `src/server/reviewService.ts`, `src/server/baseSync.ts`, `src/server/evaluationService.ts`, or any test file.
- `waitForRepoLeaseRelease` and `LEASE_SETTLE_MS` are both already exported from `src/server/integrity.ts`; import them from `"./integrity"`. Do not add any import from `./repoLeases` other than `releaseStaleLeases`.
- Never write the number 28 in the spec file: spec 28 belongs to a different card.
- Do not set or override `TMPDIR`, and never point temp directories inside the worktree.