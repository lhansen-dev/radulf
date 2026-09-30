import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/** How a worktree came by its `node_modules`, for the event on the card. */
export type DepsProvision = "copied" | "skipped";

/**
 * Give a fresh worktree the parent checkout's `node_modules`.
 *
 * Radulf never ran an install in a worktree, so every loop agent improvised
 * one, and the quick improvisation, `ln -s <checkout>/node_modules`, breaks
 * `next build`: Turbopack refuses a `node_modules` symlink that resolves
 * outside the project root, and Next stops its root search at the worktree
 * boundary. A real directory is what the build wants, so this makes one:
 * files copied from the checkout while preserving package symlinks. Separate
 * files are required because the worktree is agent-writable and a hard link
 * would let an in-place edit mutate the trusted parent checkout.
 *
 * Only when the install can be assumed to match: the checkout's
 * `node_modules` is a real directory, both sides carry a `package-lock.json`
 * and the two are identical, and the worktree has no `node_modules` yet.
 * Anything else returns "skipped" and leaves the agent to install as it sees
 * fit.
 */
export async function provisionNodeModules(repoPath: string, worktreePath: string): Promise<DepsProvision> {
  const src = path.join(repoPath, "node_modules");
  const dst = path.join(worktreePath, "node_modules");
  if (fs.existsSync(dst)) return "skipped";
  let srcStat: fs.Stats;
  try {
    srcStat = fs.lstatSync(src);
  } catch {
    return "skipped";
  }
  if (!srcStat.isDirectory()) return "skipped";
  if (!sameLockfile(repoPath, worktreePath)) return "skipped";
  await fsp.cp(src, dst, { recursive: true, verbatimSymlinks: true });
  return "copied";
}

function sameLockfile(a: string, b: string): boolean {
  try {
    return fs
      .readFileSync(path.join(a, "package-lock.json"))
      .equals(fs.readFileSync(path.join(b, "package-lock.json")));
  } catch {
    return false;
  }
}
