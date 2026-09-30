/**
 * Spec 29 — sync a finished loop's worktree with its base branch.
 *
 * When a loop signals DONE, the orchestrator merges the base branch into the
 * worktree before running the repository gate and evaluation. A clean merge
 * produces a merge commit; a conflicted merge is LEFT IN PROGRESS (markers in
 * the working tree, MERGE_HEAD present) so the loop can resolve it as a task,
 * after which the orchestrator completes the commit.
 *
 * One case is handled before the merge: a base whose history was rewritten
 * (amend, rebase, force-push) after the worktree branched from it. The branch
 * then carries a commit the base no longer has, and merging conflicts on that
 * commit's files although the loop never touched them. Radulf's own commits
 * are replayed onto the new base tip instead; only when that replay conflicts
 * does the merge, and the loop, take over as before.
 */
import { tryGit } from "./git";

export type BaseSyncResult =
  | { status: "up-to-date" }
  | { status: "merged"; mergeCommit: string }
  | { status: "rebased"; onto: string; replayed: number; dropped: string[] }
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

  const rewritten = await rewrittenBase(worktreePath, baseBranch);
  if (rewritten) {
    const onto = await replayOntoBase(worktreePath, baseBranch, branch, rewritten.own);
    if (onto) {
      return { status: "rebased", onto, replayed: rewritten.own.length, dropped: rewritten.dropped };
    }
  }

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

/** Every commit Radulf writes on a run branch carries this subject prefix, and
 * the loop agent may not commit, so the prefix tells Radulf's commits from a
 * base's. */
const OWN_SUBJECT = /^ralph: /;

/**
 * Whether the base's history was rewritten under the branch, and if so which
 * commits are Radulf's own and which are leftovers of the old base.
 *
 * Radulf's first commit on a branch is the plan, made right after
 * `createWorktree`, so its parent is the base tip the branch forked from.
 * Walked first-parent so commits an earlier sync merged in from the base do
 * not count. Null when the branch has no Radulf commit to anchor it, when a
 * commit on the first-parent line is not Radulf's (someone else committed in
 * the worktree; nothing is replayed then), or when the fork point is still on
 * the base, which is the ordinary "base moved forward" case the merge handles.
 */
async function rewrittenBase(
  worktreePath: string,
  baseBranch: string,
): Promise<{ own: string[]; dropped: string[] } | null> {
  const log = await tryGit(
    worktreePath,
    "log",
    "--reverse",
    "--first-parent",
    "--format=%H%x00%P%x00%s",
    `${baseBranch}..HEAD`,
  );
  if (!log.ok) return null;
  const lines = log.out.split("\n").filter((l) => l.trim() !== "");
  const first = lines.findIndex((l) => OWN_SUBJECT.test(l.split("\0")[2] ?? ""));
  if (first < 0) return null;
  const dropped = lines.slice(0, first).map((l) => l.split("\0")[0]);
  const own: string[] = [];
  for (const line of lines.slice(first)) {
    const [sha, parents, subject] = line.split("\0");
    if (!OWN_SUBJECT.test(subject ?? "")) return null;
    // A merge commit brought base content in; the new base is the truth for that.
    if ((parents ?? "").trim().split(" ").length > 1) continue;
    own.push(sha);
  }
  if (dropped.length === 0) return null;
  const forkPoint = (lines[first].split("\0")[1] ?? "").trim().split(" ")[0];
  if (!forkPoint) return null;
  const onBase = await tryGit(worktreePath, "merge-base", "--is-ancestor", forkPoint, baseBranch);
  if (onBase.ok) return null;
  return { own, dropped };
}

/**
 * Cherry-pick `own` onto the base tip and point `branch` at the result. Returns
 * the base tip the commits now sit on, or null after restoring the branch
 * untouched when a pick conflicts, so the caller can fall back to the merge.
 */
async function replayOntoBase(
  worktreePath: string,
  baseBranch: string,
  branch: string,
  own: string[],
): Promise<string | null> {
  const detach = await tryGit(worktreePath, "checkout", "--detach", baseBranch);
  if (!detach.ok) return null;
  const onto = (await tryGit(worktreePath, "rev-parse", "HEAD")).out.trim();
  if (own.length > 0) {
    const pick = await tryGit(worktreePath, "cherry-pick", "--allow-empty", "--keep-redundant-commits", ...own);
    if (!pick.ok) {
      await tryGit(worktreePath, "cherry-pick", "--abort");
      await tryGit(worktreePath, "checkout", branch);
      return null;
    }
  }
  const moved = await tryGit(worktreePath, "branch", "-f", branch, "HEAD");
  if (!moved.ok) {
    await tryGit(worktreePath, "checkout", branch);
    return null;
  }
  if (!(await tryGit(worktreePath, "checkout", branch)).ok) return null;
  return onto;
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
