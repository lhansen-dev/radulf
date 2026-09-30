import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ClientError } from "./clientError";
import { isInsideOrEqual, realpathBestEffort } from "./sandbox/pathGuard";

/**
 * Directory browsing for the repository picker.
 *
 * The previous picker shelled out to macOS `osascript` and opened a dialog on
 * the machine running the server, which meant it did not work on Linux at all
 * and could not work from a phone on any platform, since the dialog appears on
 * the host's screen rather than in the browser. This lists directories over
 * HTTP instead, so the picker works wherever the UI does.
 *
 * That trade has a cost the native dialog did not carry: an HTTP endpoint that
 * lists directories is reachable by anything that can reach Radulf, and Radulf
 * binds 0.0.0.0 once a password hash is configured (spec 08). So every path is
 * confined beneath a single configured root, resolved through symlinks the same
 * way the sandbox's tool guard resolves them.
 */

export type FolderEntry = {
  name: string;
  path: string;
  /** A `.git` entry is present, so this is worth offering as a repository.
   * Advisory only: POST /api/repos re-validates with git itself before adding
   * anything, because a `.git` that exists is not the same as a repo that can
   * be branched from. */
  isGitRepo: boolean;
};

export type FolderListing = {
  /** The confinement root, so the UI can tell when it is at the top. */
  root: string;
  path: string;
  /** Null at the root: there is nowhere further up to go. */
  parent: string | null;
  entries: FolderEntry[];
  /** True when the directory held more children than MAX_ENTRIES. */
  truncated: boolean;
};

/** A directory of ten thousand entries should not become a ten thousand row
 * response. Repos live in shallow, human-sized directories. */
const MAX_ENTRIES = 500;

/**
 * The single directory browsing is confined to. A blank setting means the
 * server user's home directory, which is where repositories live on a normal
 * install; widening it is a deliberate act.
 */
export function browsableRoot(configured: string): string {
  const trimmed = configured.trim();
  return realpathBestEffort(trimmed || os.homedir());
}

/**
 * The real path of `target`, or a ClientError when it is not inside the
 * browsable root.
 *
 * Every HTTP surface that names a path on the machine running Radulf shares
 * this confinement, not just the listing endpoint: the picker only ever offers
 * paths inside the root, so a request naming one outside it did not come from
 * the picker. Resolved through symlinks first, so a link inside the root
 * pointing at `/etc` is not a way out of it.
 */
export function assertInsideBrowsableRoot(target: string, configuredRoot: string): string {
  const resolved = realpathBestEffort(target);
  if (!isInsideOrEqual(resolved, browsableRoot(configuredRoot))) {
    throw new ClientError("that folder is outside the browsable root");
  }
  return resolved;
}

/** True when `dir` carries a `.git` entry, of either kind: a directory for a
 * normal clone, a file for a linked worktree. */
function looksLikeGitRepo(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, ".git"));
  } catch {
    return false;
  }
}

/**
 * List the directories inside `requested`, or inside the root when it is
 * blank. Throws a ClientError when the path escapes the root, does not exist,
 * or cannot be read, so the UI can say which without a stack trace.
 */
export function listFolder(requested: string | null, configuredRoot: string): FolderListing {
  const root = browsableRoot(configuredRoot);
  const target = realpathBestEffort(
    requested && requested.trim() ? requested.trim() : root,
  );

  // Segment-safe, and resolved through symlinks first, so a symlink inside the
  // root pointing at /etc does not become a way out of it.
  if (!isInsideOrEqual(target, root)) {
    throw new ClientError("that folder is outside the browsable root");
  }

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(target, { withFileTypes: true });
  } catch (cause) {
    const code = (cause as { code?: string }).code;
    if (code === "ENOENT") throw new ClientError("that folder does not exist");
    if (code === "ENOTDIR") throw new ClientError("that path is not a folder");
    if (code === "EACCES" || code === "EPERM") throw new ClientError("that folder is not readable");
    throw new ClientError("could not read that folder");
  }

  const all = dirents
    // Directories only: a repository is a directory, and listing files would
    // widen what this endpoint discloses for no gain. Hidden entries are
    // skipped because repos do not live in them and they are most of the noise
    // in a home directory.
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));

  const entries = all.slice(0, MAX_ENTRIES).map((entry) => {
    const full = path.join(target, entry.name);
    return { name: entry.name, path: full, isGitRepo: looksLikeGitRepo(full) };
  });

  return {
    root,
    path: target,
    parent: isInsideOrEqual(target, root) && target !== root ? path.dirname(target) : null,
    entries,
    truncated: all.length > MAX_ENTRIES,
  };
}
