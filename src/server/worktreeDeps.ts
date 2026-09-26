import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/** How a worktree came by its `node_modules`, for the event on the card. */
export type DepsProvision = "hardlinked" | "copied" | "skipped";

/**
 * Give a fresh worktree the parent checkout's `node_modules`.
 *
 * Radulf never ran an install in a worktree, so every loop agent improvised
 * one, and the quick improvisation, `ln -s <checkout>/node_modules`, breaks
 * `next build`: Turbopack refuses a `node_modules` symlink that resolves
 * outside the project root, and Next stops its root search at the worktree
 * boundary. A real directory is what the build wants, so this makes one:
 * every file hard-linked to the checkout's copy (seconds, no extra disk), or
 * copied when the two trees sit on different mounts, as they do when the
 * checkout is bind-mounted into a container whose worktrees live in the state
 * volume.
 *
 * Only when the install can be assumed to match: the checkout's
 * `node_modules` is a real directory, both sides carry a `package-lock.json`
 * and the two are identical, and the worktree has no `node_modules` yet.
 * Anything else returns "skipped" and leaves the agent to install as it sees
 * fit. Hard links share content, so a loop that edited a file inside
 * `node_modules` in place would edit the checkout's copy too; npm replaces
 * files rather than editing them, and agents have no business in there.
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
  try {
    await linkTree(src, dst);
    return "hardlinked";
  } catch (err) {
    await fsp.rm(dst, { recursive: true, force: true });
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
  }
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

/** Recreate `from` under `to`: directories made, symlinks reproduced
 * verbatim, every regular file a hard link to the original. Throws EXDEV on
 * the first file when the two trees are on different mounts. */
async function linkTree(from: string, to: string): Promise<void> {
  await fsp.mkdir(to);
  for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
    const f = path.join(from, entry.name);
    const t = path.join(to, entry.name);
    if (entry.isDirectory()) await linkTree(f, t);
    else if (entry.isSymbolicLink()) await fsp.symlink(await fsp.readlink(f), t);
    else await fsp.link(f, t);
  }
}
