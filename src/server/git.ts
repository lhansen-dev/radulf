import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { WORKTREES_DIR } from "@/db";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

/** Run git, throwing on a non-zero exit. Async so a slow or large git
 * operation never blocks the server event loop (and with it the SSE stream). */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
  });
  return stdout.trim();
}

export async function tryGit(
  cwd: string,
  ...args: string[]
): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
    });
    return { ok: true, out: (stdout + stderr).trim() };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, out: ((err.stdout ?? "") + (err.stderr ?? "")).trim() };
  }
}

/** List local branch names; returns [] when the path is not a git repo. */
export async function listBranches(repoPath: string): Promise<string[]> {
  if (!(await isGitRepo(repoPath))) return [];
  const { ok, out } = await tryGit(repoPath, "branch", "--format=%(refname:short)");
  if (!ok || !out) return [];
  return out.split("\n").filter(Boolean);
}

/** Ask Git to validate the exact branch shorthand. Unlike hand-written
 * regexes this follows the installed Git's ref rules. */
export async function isValidBranchName(name: string): Promise<boolean> {
  if (!name || name.startsWith("-")) return false;
  return (await tryGit(process.cwd(), "check-ref-format", "--branch", name)).ok;
}

/** Return the repo's current branch name; falls back when HEAD is detached. */
export async function currentBranch(repoPath: string, fallback: string): Promise<string> {
  const { ok, out } = await tryGit(repoPath, "rev-parse", "--abbrev-ref", "HEAD");
  if (!ok || out === "" || out === "HEAD") return fallback;
  return out;
}

export async function isGitRepo(dir: string): Promise<boolean> {
  return fs.existsSync(dir) && (await tryGit(dir, "rev-parse", "--git-dir")).ok;
}

export function slugify(s: string): string {
  return (
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "card"
  );
}

export async function createWorktree(
  repoPath: string,
  defaultBranch: string,
  cardTitle: string,
  runId: string
): Promise<{ worktreePath: string; branch: string }> {
  const slug = slugify(cardTitle);
  const worktreePath = path.join(WORKTREES_DIR, `${slug}-${runId}`);
  const branch = `ralph/${slug}-${runId}`;
  await git(repoPath, "worktree", "add", worktreePath, "-b", branch, defaultBranch);
  return { worktreePath, branch };
}

export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string
): Promise<void> {
  await tryGit(repoPath, "worktree", "remove", "--force", worktreePath);
  await tryGit(repoPath, "worktree", "prune");
  await tryGit(repoPath, "branch", "-D", branch);
  fs.rmSync(worktreePath, { recursive: true, force: true });
}

// Flags shared by every review-facing diff invocation. `--no-ext-diff` and
// `--no-textconv` refuse any GIT_EXTERNAL_DIFF / diff.<driver>.command /
// diff.<driver>.textconv hijack (a diff driver an agent planted in local
// .git/config, wired up via a `.gitattributes` `diff=<name>` entry, would
// otherwise run in place of git's own diff and can show reviewers fabricated
// content); `--text` forces line-level diff even when `.gitattributes` marks
// a path binary or `-diff` (Trojan-Source-style diff suppression); `-c
// core.excludesFile=/dev/null` stops a global excludes file from hiding
// anything from the *listing* (the pathspec below already ignores
// .gitignore for tracked-content diffing, but this keeps future
// path-selection logic honest too).
const REVIEW_DIFF_FLAGS = [
  "-c",
  "core.excludesFile=/dev/null",
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--text",
] as const;

export async function worktreeDiff(
  worktreePath: string,
  defaultBranch: string
): Promise<string> {
  const base = await git(worktreePath, "merge-base", defaultBranch, "HEAD");
  return git(worktreePath, ...REVIEW_DIFF_FLAGS, base, "HEAD", "--", ".", ":(exclude).ralph");
}

export async function worktreeDiffStat(
  worktreePath: string,
  defaultBranch: string
): Promise<string> {
  const base = await git(worktreePath, "merge-base", defaultBranch, "HEAD");
  return git(
    worktreePath,
    ...REVIEW_DIFF_FLAGS,
    "--shortstat",
    base,
    "HEAD",
    "--",
    ".",
    ":(exclude).ralph"
  );
}

/** Paths changed between the merge-base and HEAD, same scope as
 * `worktreeDiff` (`.ralph` excluded) — used to flag sensitive-path and
 * ignore-file changes in the review UI without re-parsing the diff text. */
export async function worktreeChangedPaths(
  worktreePath: string,
  defaultBranch: string
): Promise<string[]> {
  const base = await git(worktreePath, "merge-base", defaultBranch, "HEAD");
  const out = await git(
    worktreePath,
    ...REVIEW_DIFF_FLAGS,
    "--name-only",
    base,
    "HEAD",
    "--",
    ".",
    ":(exclude).ralph"
  );
  return out ? out.split("\n").filter(Boolean) : [];
}

/** Return true when the worktree has uncommitted changes (git status --porcelain is non-empty). */
export async function worktreeIsDirty(worktreePath: string): Promise<boolean> {
  if (!fs.existsSync(worktreePath)) return false;
  const { ok, out } = await tryGit(worktreePath, "status", "--porcelain");
  return ok && out.trim().length > 0;
}

/** Merge the ralph branch into the repo's base branch. Always restores the
 * checkout the user's repo was on before the merge — merging must never
 * leave their working copy switched to the base branch. */
export async function mergeBranch(
  repoPath: string,
  baseBranch: string,
  branch: string,
  message: string
): Promise<{ ok: boolean; mergeCommit?: string; error?: string; conflict?: boolean }> {
  const original = await git(repoPath, "rev-parse", "--abbrev-ref", "HEAD");
  const restore = async () => {
    // A detached HEAD ("HEAD") has no branch to restore.
    if (original !== baseBranch && original !== "HEAD") {
      await tryGit(repoPath, "checkout", original);
    }
  };
  if (original !== baseBranch) {
    const co = await tryGit(repoPath, "checkout", baseBranch);
    if (!co.ok) return { ok: false, error: `cannot checkout ${baseBranch}: ${co.out}` };
  }
  const dirty = await git(repoPath, "status", "--porcelain");
  if (dirty) {
    await restore();
    return { ok: false, error: "target checkout has uncommitted changes" };
  }
  // --no-commit so .ralph/ (plan artifacts, loop memory) can be dropped before
  // committing — the reviewed diff excludes it, so the merge must too.
  const merge = await tryGit(repoPath, "merge", "--no-ff", "--no-commit", branch);
  if (!merge.ok) {
    await tryGit(repoPath, "merge", "--abort");
    await restore();
    // A content conflict is recoverable: the branch is stale relative to a base
    // that moved under it. The caller hands it back to the loop (see
    // mergeBaseIntoWorktree) rather than dead-ending. Flag it so the caller can
    // tell a conflict apart from an unrecoverable failure.
    return { ok: false, conflict: true, error: `merge conflict — rebase needed: ${merge.out}` };
  }
  await tryGit(repoPath, "rm", "-r", "-f", "-q", "--ignore-unmatch", ".ralph");
  fs.rmSync(path.join(repoPath, ".ralph"), { recursive: true, force: true });
  const commit = await tryGit(repoPath, "commit", "-m", message);
  if (!commit.ok) {
    await tryGit(repoPath, "merge", "--abort");
    await tryGit(repoPath, "reset", "--hard", "HEAD");
    await restore();
    return { ok: false, error: `merge commit failed: ${commit.out}` };
  }
  const mergeCommit = await git(repoPath, "rev-parse", "HEAD");
  await restore();
  return { ok: true, mergeCommit };
}

/**
 * Merge the base branch *into* the feature branch inside its worktree,
 * deliberately leaving any conflicts in the working tree for the loop to
 * resolve. Once the loop resolves and commits the merge, the branch contains
 * base, so the later merge back into base is clean.
 *
 * A clean result means base merged with no overlap. `conflicted` means the
 * working tree now holds conflict markers awaiting resolution — that is the
 * expected, wanted outcome here, not an error. Any other failure aborts the
 * merge so the worktree is left untouched.
 */
export async function mergeBaseIntoWorktree(
  worktreePath: string,
  baseBranch: string
): Promise<{ ok: boolean; conflicted: boolean; out: string }> {
  const res = await tryGit(worktreePath, "merge", "--no-ff", "--no-edit", baseBranch);
  if (res.ok) return { ok: true, conflicted: false, out: res.out };
  const conflicted = /conflict/i.test(res.out);
  if (!conflicted) await tryGit(worktreePath, "merge", "--abort");
  return { ok: false, conflicted, out: res.out };
}
