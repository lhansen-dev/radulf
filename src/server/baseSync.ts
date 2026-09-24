/**
 * Spec 29 — sync a finished loop's worktree with its base branch.
 *
 * When a loop signals DONE, the orchestrator merges the base branch into the
 * worktree before running the repository gate and evaluation. A clean merge
 * produces a merge commit; a conflicted merge is LEFT IN PROGRESS (markers in
 * the working tree, MERGE_HEAD present) so the loop can resolve it as a task,
 * after which the orchestrator completes the commit.
 */
import { tryGit } from "./git";

export type BaseSyncResult =
  | { status: "up-to-date" }
  | { status: "merged"; mergeCommit: string }
  | { status: "conflicted"; files: string[]; out: string }
  | { status: "failed"; error: string };

/**
 * Merge `baseBranch` into the worktree's current branch (`branch`). Returns
 * `up-to-date` without touching anything when the base is already an ancestor
 * of HEAD. On conflict the merge is left in progress for the loop to resolve;
 * any other merge failure is aborted and reported as `failed`.
 */
export async function syncWithBase(
  worktreePath: string,
  baseBranch: string,
  branch: string,
): Promise<BaseSyncResult> {
  const ancestor = await tryGit(worktreePath, "merge-base", "--is-ancestor", baseBranch, "HEAD");
  if (ancestor.ok) return { status: "up-to-date" };

  const merge = await tryGit(
    worktreePath,
    "merge",
    "--no-ff",
    "--no-edit",
    "-m",
    `ralph: merge ${baseBranch} into ${branch}`,
    baseBranch,
  );
  if (merge.ok) {
    return { status: "merged", mergeCommit: (await tryGit(worktreePath, "rev-parse", "HEAD")).out };
  }

  const conflicted = await tryGit(worktreePath, "diff", "--name-only", "--diff-filter=U");
  const files = conflicted.out.split("\n").filter((f) => f.trim() !== "");
  if (files.length > 0) return { status: "conflicted", files, out: merge.out };

  await tryGit(worktreePath, "merge", "--abort");
  return { status: "failed", error: merge.out };
}

/** Abandon an in-progress merge left by `syncWithBase`. */
export async function abortMerge(worktreePath: string): Promise<void> {
  await tryGit(worktreePath, "merge", "--abort");
}

/** Whether a merge is still in progress in the worktree (MERGE_HEAD set) —
 * what a run that died between a conflict and its resolution leaves behind. */
export async function mergeInProgress(worktreePath: string): Promise<boolean> {
  return (await tryGit(worktreePath, "rev-parse", "-q", "--verify", "MERGE_HEAD")).ok;
}

/** Task text handed back to the loop when the base-branch merge conflicted. */
export function resolveConflictsTaskText(baseBranch: string, files: string[]): string {
  return [
    `Resolve the merge conflicts left in ${files.join(", ")} after the orchestrator merged the base branch ${baseBranch} into your branch.`,
    "Each of those files now contains `<<<<<<<` / `=======` / `>>>>>>>` markers because the base branch changed while you worked. Edit each file so it keeps both your work and the base branch's intent, and remove every marker. Do not run any git command that changes state: the orchestrator completes the merge commit when you write `.ralph/ITERATION_DONE`. Run `git diff --check` as this task's targeted check.",
  ].join("\n");
}
