import fs from "node:fs";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, now, worktrees, WORKTREES_DIR } from "@/db";
import { ClientError } from "./clientError";
import { execBounded } from "./exec";

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

type ExecGitOptions = { timeoutMs?: number; env?: NodeJS.ProcessEnv };

/** Run `git -C cwd ...args` under `execBounded`'s two-signal timeout,
 * rejecting on any failure with the child's output attached to the error. */
async function execGit(
  cwd: string,
  args: string[],
  options: ExecGitOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const { err, stdout, stderr, timedOut } = await execBounded("git", ["-C", cwd, ...args], {
    timeoutMs,
    maxBuffer: MAX_BUFFER,
    ...(options.env ? { env: options.env } : {}),
  });
  if (!err) return { stdout, stderr };
  if (!timedOut) throw Object.assign(err, { stdout, stderr });
  // Make the failure actionable instead of an opaque "Command failed" —
  // surfaced both via the thrown Error's message (git()) and via `out`
  // (tryGit(), which never looks at err.message).
  const msg = `git ${args.join(" ")} timed out after ${timeoutMs}ms`;
  err.message = msg;
  throw Object.assign(err, { stdout, stderr: stderr ? `${stderr}\n${msg}` : msg });
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

/** The repo-registration check: `dir` must be a git repository with at
 * least one commit, otherwise a ClientError the API returns verbatim. */
export async function assertUsableRepo(dir: string): Promise<void> {
  if (!(await isGitRepo(dir))) throw new ClientError(`${dir} is not a git repository`);
  // An unborn HEAD has no ref to branch a worktree from — reject here rather
  // than let every task on this repo die at `git worktree add`.
  if (!(await hasCommits(dir))) {
    throw new ClientError(`${dir} has no commits yet — make an initial commit before adding it`);
  }
}

/** ClientError unless `name` is a local branch of the repo; `label` names
 * the field in the message ("baseBranch does not exist in the repository"). */
export async function assertBranchExists(repoPath: string, name: string, label: string): Promise<void> {
  if (!(await listBranches(repoPath)).includes(name)) {
    throw new ClientError(`${label} does not exist in the repository`);
  }
}

function slugify(s: string): string {
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
  // Keep a non-ASCII path readable and, more to the point, PARSEABLE: git
  // C-quotes the whole `diff --git` header when a path has a byte it will not
  // print raw, and the review page prefix-matches those paths to decide
  // whether to raise its sandbox/self-modifying banners. A header it cannot
  // parse is a banner that does not fire, which is the same class of problem
  // as the textconv and `-diff` hijacks the flags below shut down. This does
  // not cover a `"`, a `\` or a control character in a path — git quotes
  // those regardless — so `diffHeaderPath` unquotes on the client as well.
  "-c",
  "core.quotePath=false",
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--text",
] as const;

/** The review diff: merge-base of `defaultBranch` and HEAD up to HEAD, under
 * REVIEW_DIFF_FLAGS, with `.ralph` excluded. `flags` go to `git diff`. */
async function reviewDiff(
  worktreePath: string,
  defaultBranch: string,
  ...flags: string[]
): Promise<string> {
  const base = await git(worktreePath, "merge-base", defaultBranch, "HEAD");
  return git(
    worktreePath,
    ...REVIEW_DIFF_FLAGS,
    ...flags,
    base,
    "HEAD",
    "--",
    ".",
    ":(exclude).ralph"
  );
}

export async function worktreeDiff(
  worktreePath: string,
  defaultBranch: string
): Promise<string> {
  return reviewDiff(worktreePath, defaultBranch);
}

export async function worktreeDiffStat(
  worktreePath: string,
  defaultBranch: string
): Promise<string> {
  return reviewDiff(worktreePath, defaultBranch, "--shortstat");
}

/** Return true when the worktree has uncommitted changes (git status --porcelain is non-empty). */
export async function worktreeIsDirty(worktreePath: string): Promise<boolean> {
  if (!fs.existsSync(worktreePath)) return false;
  const { ok, out } = await tryGit(worktreePath, "status", "--porcelain");
  return ok && out.trim().length > 0;
}

/** Drop `.ralph/` from the index and, once git has let go of it, from disk.
 * Returns the `git rm` result. `mergeBranch` and `stripRalphForDelivery` have
 * to agree on exactly this (see the latter's docstring), so both call here. */
async function removeRalphDir(cwd: string): Promise<{ ok: boolean; out: string }> {
  const removed = await tryGit(cwd, "rm", "-r", "-f", "-q", "--ignore-unmatch", ".ralph");
  if (removed.ok) fs.rmSync(path.join(cwd, ".ralph"), { recursive: true, force: true });
  return removed;
}

// mergeBranch operates on repoPath — the ONE shared parent working tree and
// index, not a per-card worktree. Spec 20 lets different cards in the same
// repo run concurrently, and each review's own claim only serializes that
// card's merge against itself (reviewService.ts), so two cards' merges can
// otherwise interleave on the same index: one's `--no-commit` merge can be
// clobbered by the other's `status --porcelain` still reading clean before
// the first commits. Chain merges per repoPath so only one runs against a
// given repo at a time; a different repoPath gets its own chain, so
// concurrent cards in different repos are unaffected. globalThis-backed for
// the same reason as the orchestrator singleton and the event bus
// (events.ts) — survive Next.js dev hot-reload, one map per process.
const g = globalThis as unknown as { __radulfMergeLocks?: Map<string, Promise<void>> };
const mergeLocks = (g.__radulfMergeLocks ??= new Map());

/** Run `fn` after any merge already queued for `repoPath` has settled,
 * whether it resolved or threw — a failed merge must not wedge every later
 * merge queued behind it in this repo. The queued tail always resolves
 * (rejections are swallowed there), only the caller's own `fn()` result can
 * reject. */
export async function withRepoMergeLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const prior = mergeLocks.get(repoPath) ?? Promise.resolve();
  const result = prior.then(fn, fn);
  mergeLocks.set(
    repoPath,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
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
  return withRepoMergeLock(repoPath, () => mergeBranchLocked(repoPath, baseBranch, branch, message));
}

async function mergeBranchLocked(
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
  await removeRalphDir(repoPath);
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
const PR_REMOTE = "origin";

/** Does this repo have an `origin` to push to? Most registered repos are
 * local-only, so PR delivery is offered per repo, not globally. */
export async function hasRemote(repoPath: string): Promise<boolean> {
  const { ok, out } = await tryGit(repoPath, "remote", "get-url", PR_REMOTE);
  return ok && out.trim().length > 0;
}

/**
 * Drop `.ralph/` from the branch and commit that removal.
 *
 * Every review surface excludes `.ralph` (`worktreeDiff` and `worktreeDiffStat`
 * both pass `:(exclude).ralph`) and `mergeBranch` strips
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
  const removed = await removeRalphDir(worktreePath);
  if (!removed.ok) return removed;
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
