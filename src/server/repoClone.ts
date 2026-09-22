import fs from "node:fs";
import path from "node:path";
import { CLONES_DIR } from "@/db";
import { ClientError } from "./clientError";
import { assertUsableRepo, cloneRemote, tryGit } from "./git";
import { assertRepoName } from "./repoInit";
import { errorMessage } from "@/shared/errorMessage";

/** The transports a registration may clone over. A bare path is not one:
 * registering a checkout that already exists on this machine is
 * POST /api/repos, and `ext::` is a command, not a URL. */
const CLONE_URL = /^(https?:\/\/|ssh:\/\/|git@[^\s/:]+:|file:\/\/)\S+$/;

/**
 * Clone `url` into `<data-parent>/repos/<name>` (spec 21) so a repository can
 * be registered without already living on this machine: on a container
 * install that is the difference between a bind mount and none. Runs with the
 * operator's own git credentials, host-side, from the registration path only.
 * Returns what POST /api/repos needs; the caller registers it.
 */
export async function cloneRepository(
  url: string,
  requestedName: string,
): Promise<{ name: string; path: string; defaultBranch: string }> {
  if (!CLONE_URL.test(url)) {
    throw new ClientError("clone URL must start with https://, http://, ssh://, git@host:, or file://");
  }
  const name = requestedName || nameFromUrl(url);
  assertRepoName(name);
  const target = path.join(CLONES_DIR, name);
  if (fs.existsSync(target)) throw new ClientError(`${target} already exists`);
  try {
    fs.mkdirSync(CLONES_DIR, { recursive: true });
  } catch (cause) {
    throw new ClientError(`could not create ${CLONES_DIR}: ${errorMessage(cause)}`);
  }

  const cloned = await cloneRemote(url, target, CLONES_DIR);
  if (!cloned.ok) {
    fs.rmSync(target, { recursive: true, force: true });
    throw new ClientError(`git clone failed: ${cloned.error}`);
  }
  try {
    // An empty remote clones fine and is still unusable: the same rule as
    // registering an existing checkout applies.
    await assertUsableRepo(target);
  } catch (cause) {
    fs.rmSync(target, { recursive: true, force: true });
    throw cause;
  }
  return { name, path: target, defaultBranch: await defaultBranchOf(target) };
}

/** `https://host/owner/repo.git` -> `repo`: the last path segment, less `.git`. */
function nameFromUrl(url: string): string {
  const last = url.replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  return last.replace(/\.git$/, "");
}

/** The branch the remote's HEAD points at, which is what the clone checked
 * out. Falls back to the checked-out branch, then `main`, as POST /api/repos does. */
async function defaultBranchOf(repoPath: string): Promise<string> {
  const remoteHead = await tryGit(repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  if (remoteHead.ok && remoteHead.out.startsWith("origin/")) return remoteHead.out.slice("origin/".length);
  const head = await tryGit(repoPath, "rev-parse", "--abbrev-ref", "HEAD");
  return head.ok && head.out !== "HEAD" ? head.out : "main";
}
