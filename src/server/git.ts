import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, now, worktrees, WORKTREES_DIR } from "@/db";

const MAX_BUFFER = 64 * 1024 * 1024;

// Generous for any local git operation this codebase performs (worktree
// add/remove, merge, diff, branch list) — none of these touch a remote.
const GIT_TIMEOUT_MS = 30_000;
// Spec 15's push is the one exception, and 30s is the wrong bound for it: it
// crosses a network, on a link this process does not control, pushing a branch
// whose size it does not know. Long enough for a slow uplink, still bounded —
// the orchestrator runs one card at a time globally, so a wedged git freezes
// everything.
const GIT_REMOTE_TIMEOUT_MS = 10 * 60_000;
// A process wedged deep in a blocking syscall can ignore SIGTERM; escalate to
// SIGKILL this long after if it's still alive.
const GIT_KILL_GRACE_MS = 5_000;

/**
 * Run `git -C cwd ...args` with a bounded lifetime: SIGTERM at
 * GIT_TIMEOUT_MS, SIGKILL at GIT_TIMEOUT_MS + GIT_KILL_GRACE_MS if it's still
 * alive. Not built on `promisify(execFile)`'s own `timeout` option because
 * that only ever sends one signal — a hung git process (credential-helper
 * prompt on stdin, corrupt lock file, dead network mount) must not be able to
 * freeze the whole app, since the orchestrator runs exactly one card at a
 * time globally.
 */
type ExecGitOptions = { timeoutMs?: number; env?: NodeJS.ProcessEnv };

function execGit(
  cwd: string,
  args: string[],
  options: ExecGitOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const child = execFile(
      "git",
      ["-C", cwd, ...args],
      {
        encoding: "utf8" as const,
        maxBuffer: MAX_BUFFER,
        ...(options.env ? { env: options.env } : {}),
      },
      (err, stdout, stderr) => {
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        if (err) {
          if (timedOut) {
            // Make the failure actionable instead of an opaque "Command
            // failed" — surfaced both via the thrown Error's message (git())
            // and via `out` (tryGit(), which never looks at err.message).
            const msg = `git ${args.join(" ")} timed out after ${timeoutMs}ms`;
            err.message = msg;
            stderr = stderr ? `${stderr}\n${msg}` : msg;
          }
          reject(Object.assign(err, { stdout, stderr }));
        } else {
          resolve({ stdout, stderr });
        }
      }
    );
    // Nothing this module runs is ever meant to read stdin. Closing it makes a
    // credential helper that decides to prompt fail immediately instead of
    // blocking on a read that will never be answered.
    child.stdin?.end();
    const termTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    const killTimer = setTimeout(() => child.kill("SIGKILL"), timeoutMs + GIT_KILL_GRACE_MS);
  });
}

/** Run git, throwing on a non-zero exit. Async so a slow or large git
 * operation never blocks the server event loop (and with it the SSE stream). */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execGit(cwd, args);
  return stdout.trim();
}

export async function tryGit(
  cwd: string,
  ...args: string[]
): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await execGit(cwd, args);
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

/** `ralph/` is the namespace Radulf writes itself: card run branches and
 * improvement-run feature branches (spec 19). A card must never be based on
 * one. A run branch is checked out in a worktree Radulf owns, so the merge on
 * approval cannot check it out, and once its card is gone the branch is an
 * orphan that looks like any other branch in the picker. */
export function isRalphBranch(name: string): boolean {
  return name.startsWith("ralph/");
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

/**
 * Null when `worktreePath` has `branch` checked out; otherwise why nothing
 * must be committed there. Every orchestrator commit is meant for the run's
 * own `ralph/` branch, and nothing else keeps the worktree on it: an agent
 * that runs `git checkout <base>` inside the worktree routes every commit
 * after it onto the base branch, where the run-end integrity check then
 * reads Radulf's own work as tampering (`integrity.ts`).
 */
export async function offRunBranchReason(
  worktreePath: string,
  branch: string,
): Promise<string | null> {
  const { ok, out } = await tryGit(worktreePath, "symbolic-ref", "--quiet", "--short", "HEAD");
  const current = ok && out ? out : null;
  if (current === branch) return null;
  return `worktree left its run branch: on ${current ?? "a detached HEAD"}, expected ${branch}`;
}

export async function isGitRepo(dir: string): Promise<boolean> {
  return fs.existsSync(dir) && (await tryGit(dir, "rev-parse", "--git-dir")).ok;
}

/** True when HEAD resolves to a commit. A freshly `git init`-ed repo is a valid
 * repo with an unborn HEAD and no refs at all — nothing can be branched from it,
 * so every worktree-based flow has to reject it up front rather than fail on an
 * opaque `invalid reference: main` from `git worktree add`. */
export async function hasCommits(dir: string): Promise<boolean> {
  return (await tryGit(dir, "rev-parse", "--verify", "--quiet", "HEAD^{commit}")).ok;
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
  // Check the base ref before branching so the failure names the real problem.
  // Raw `git worktree add` reports both an empty repo and a typo'd branch as
  // `invalid reference: <base>`, which surfaced in the UI as an unactionable
  // "Command failed: git -C …" on the very first task of a fresh `git init`.
  const base = await tryGit(repoPath, "rev-parse", "--verify", "--quiet", `${defaultBranch}^{commit}`);
  if (!base.ok) {
    throw new Error(
      (await hasCommits(repoPath))
        ? `base branch "${defaultBranch}" does not exist in ${repoPath}`
        : `${repoPath} has no commits yet — make an initial commit before running tasks against it`
    );
  }
  const add = await tryGit(repoPath, "worktree", "add", worktreePath, "-b", branch, defaultBranch);
  if (!add.ok) throw new Error(`git worktree add failed: ${add.out}`);
  return { worktreePath, branch };
}

/** Record a freshly created worktree's `worktrees` row. `worktrees.runId` is
 * a real foreign key, so callers must insert the owning `runs` row first —
 * this is why it's split out of `createWorktree` rather than done there,
 * where the run doesn't exist yet. */
export function recordWorktree(repoId: string, runId: string, path: string, branch: string): void {
  db.insert(worktrees)
    .values({ id: nanoid(), repoId, runId, path, branch, createdAt: now() })
    .run();
}

/** Stamp the `worktrees` row for `worktreePath` as removed. Idempotent — a
 * row already marked removed (or with no matching row at all) is a no-op,
 * shared by both `removeWorktree` and the retention sweep's orphan GC. */
export function markWorktreeRemoved(worktreePath: string): void {
  db.update(worktrees)
    .set({ removedAt: now() })
    .where(and(eq(worktrees.path, worktreePath), isNull(worktrees.removedAt)))
    .run();
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
  markWorktreeRemoved(worktreePath);
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

// ─── Spec 15: remote delivery ────────────────────────────────────────────────
//
// Everything below is the ONLY part of this module that touches a remote, and
// it runs exclusively host-side from the review path, after a human (or an
// explicit auto-approve grant) has released the diff. No agent can reach it:
// there is no tool binding for any of it, `git push` stays blocked inside the
// sandbox by spec 14's egress proxy and socket policy, and `~/.config/gh`
// stays on 14's deny list. That is a permanent property, not a phase-one one.

/** The remote a card's branch is pushed to. Not configurable — a repo with a
 * differently-named remote is out of scope rather than silently guessed at. */
export const PR_REMOTE = "origin";

/** Does this repo have an `origin` to push to? Most registered repos are
 * local-only, so PR delivery is offered per repo, not globally. */
export async function hasRemote(repoPath: string): Promise<boolean> {
  const { ok, out } = await tryGit(repoPath, "remote", "get-url", PR_REMOTE);
  return ok && out.trim().length > 0;
}

/**
 * Drop `.ralph/` from the branch and commit that removal.
 *
 * Every review surface excludes `.ralph` (`worktreeDiff`, `worktreeDiffStat`,
 * `worktreeChangedPaths` all pass `:(exclude).ralph`) and `mergeBranch` strips
 * it before committing, so the plan artifacts, loop memory, and evaluator
 * verdict are deliberately not part of what a human approves. A push has to
 * honour the same exclusion or PR delivery would publish to a remote exactly
 * the content the local path takes care to leave behind.
 *
 * Safe to run twice: `--ignore-unmatch` no-ops when `.ralph` is already gone,
 * and with nothing staged there is no commit to make. Callers must run it
 * *after* any base-branch merge, so a hand-back to the loop never sees a
 * worktree whose memory has been stripped.
 */
export async function stripRalphForDelivery(
  worktreePath: string,
  message: string
): Promise<{ ok: boolean; out: string }> {
  const removed = await tryGit(
    worktreePath,
    "rm",
    "-r",
    "-f",
    "-q",
    "--ignore-unmatch",
    ".ralph"
  );
  if (!removed.ok) return removed;
  fs.rmSync(path.join(worktreePath, ".ralph"), { recursive: true, force: true });
  const staged = await tryGit(worktreePath, "diff", "--cached", "--quiet");
  // `--quiet` exits non-zero when there *is* something staged.
  if (staged.ok) return { ok: true, out: "" };
  return tryGit(worktreePath, "commit", "-m", message);
}

/**
 * Push the card's branch to `origin`, setting upstream.
 *
 * Never forced. A rejected non-fast-forward means someone else moved the
 * branch on the remote, and resolving that automatically is exactly the kind
 * of guess this codebase does not make — it surfaces as an error the operator
 * acts on.
 */
export async function pushBranch(
  worktreePath: string,
  branch: string
): Promise<{ ok: boolean; error?: string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Refuse to prompt for credentials on a terminal that is not there. A
    // helper that would have blocked fails loudly instead.
    GIT_TERMINAL_PROMPT: "0",
  };
  // Same intent for the SSH path, which reads a passphrase from /dev/tty and
  // so would not be stopped by a closed stdin. Only when the operator has not
  // set their own command — theirs wins.
  if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  try {
    await execGit(worktreePath, ["push", "--set-upstream", PR_REMOTE, branch], {
      timeoutMs: GIT_REMOTE_TIMEOUT_MS,
      env,
    });
    return { ok: true };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const out = ((err.stdout ?? "") + (err.stderr ?? "")).trim();
    return { ok: false, error: out || err.message || "git push failed" };
  }
}
