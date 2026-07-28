import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Layer 2 path containment (spec 14): the OS sandbox (L1) cannot reach the
 * file tools that run inside the server process, so `read`/`write`/`edit`/
 * `grep`/`find`/`ls` are wrapped (see `harness/guardedTools.ts`) and every
 * path argument passes through this one guard before the built-in runs.
 *
 * The guard is deliberately trivial — root-only, no read/write policy engine —
 * because the escape hatch for legitimate outside reads is bash, where the
 * kernel (L1), not a JS wrapper, decides. The planner has no bash and thus no
 * escape hatch, which is correct: a planner needing to read outside the repo
 * is being manipulated.
 */

/** The single error shape (spec §Layer 2). The leading "Error: " the spec
 * shows is supplied by `Error.toString()`, so the message omits it. */
export function pathBoundaryMessage(allowedRoots: string[]): string {
  return (
    `path escapes this run's boundary — this role may only touch ` +
    `${allowedRoots.join(", ")}. Use bash for read-only inspection of system paths.`
  );
}

/** Expand a leading `~` / `~/` to the home dir. `~user` is intentionally left
 * literal (unsupported) so it resolves against cwd and fails the guard. */
function expandTilde(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

/**
 * realpath a path that may not exist yet (a `write`/`edit` creating a new
 * file): resolve the deepest existing ancestor through symlinks, then
 * re-append the non-existent tail. This is what makes the guard symlink-safe —
 * a symlink planted inside the worktree pointing at `~/.ssh` resolves to its
 * real target and fails containment (checklist #5).
 */
export function realpathBestEffort(p: string): string {
  let current = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return tail.length ? path.join(real, ...tail.slice().reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached the filesystem root with nothing resolvable.
        return path.join(current, ...tail.slice().reverse());
      }
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Segment-safe containment: `child` is inside-or-equal to `root` compared by
 * path segment, not string prefix — so `<worktree>-evil` is NOT inside
 * `<worktree>`. `path.relative` yields `""` for equal, a `..`-leading or
 * absolute path for outside, and a plain relative path for inside.
 */
export function isInsideOrEqual(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve `input` (after `~` expansion, relative to `cwd`) and assert its
 * realpath falls inside one of `allowedRoots`. Returns the resolved realpath
 * on success; throws the single L2 error shape on escape.
 */
export function guardPath(
  input: string,
  allowedRoots: string[],
  cwd: string,
): string {
  const expanded = expandTilde(input);
  const abs = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
  const real = realpathBestEffort(abs);
  for (const root of allowedRoots) {
    if (isInsideOrEqual(real, realpathBestEffort(root))) return real;
  }
  throw new Error(pathBoundaryMessage(allowedRoots));
}
