import fs from "node:fs";
import path from "node:path";
import { ClientError } from "./clientError";
import { assertInsideBrowsableRoot } from "./folderBrowser";
import { tryGit } from "./git";
import { errorMessage } from "@/shared/errorMessage";

/** A folder name and nothing more: no separators, not hidden, and nothing git
 * or a shell would read as an option. */
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** ClientError unless `name` is a plain folder name. Shared with cloning. */
export function assertRepoName(name: string): void {
  if (!REPO_NAME.test(name)) {
    throw new ClientError(
      "repository name must start with a letter or digit and contain only letters, digits, dots, dashes and underscores",
    );
  }
}

const INITIAL_BRANCH = "main";

/**
 * Create a fresh repository at `<parentPath>/<name>`: `git init` on `main`, a
 * README, and one commit, so the result passes the same checks POST /api/repos
 * applies to an existing checkout (a repo with a commit to branch worktrees
 * from). Confined to the browsable root for the same reason the folder browser
 * is: this is an HTTP surface that writes to the disk of the machine running
 * Radulf.
 */
export async function initRepository(
  parentPath: string,
  name: string,
  configuredRoot: string,
): Promise<{ path: string; defaultBranch: string }> {
  assertRepoName(name);
  const parent = assertInsideBrowsableRoot(parentPath, configuredRoot);
  let parentStat: fs.Stats;
  try {
    parentStat = fs.statSync(parent);
  } catch {
    throw new ClientError("that folder does not exist");
  }
  if (!parentStat.isDirectory()) throw new ClientError("that path is not a folder");
  // Git would happily create a repository inside another checkout, and it is
  // almost never what anyone wants.
  if ((await tryGit(parent, "rev-parse", "--is-inside-work-tree")).ok) {
    throw new ClientError("that folder is already inside a git repository");
  }
  const target = path.join(parent, name);
  if (fs.existsSync(target)) throw new ClientError(`${target} already exists`);

  try {
    fs.mkdirSync(target);
  } catch (cause) {
    throw new ClientError(`could not create ${target}: ${errorMessage(cause)}`);
  }
  try {
    await step(target, "init", ["init"]);
    await step(target, "init", ["symbolic-ref", "HEAD", `refs/heads/${INITIAL_BRANCH}`]);
    fs.writeFileSync(path.join(target, "README.md"), `# ${name}\n`);
    await step(target, "add", ["add", "README.md"]);
    // The first commit carries the host's git identity when there is one. A
    // machine without one still gets a repository rather than git's "please
    // tell me who you are".
    const hasIdentity =
      (await tryGit(target, "config", "user.name")).ok && (await tryGit(target, "config", "user.email")).ok;
    const identity = hasIdentity ? [] : ["-c", "user.name=Radulf", "-c", "user.email=radulf@localhost"];
    await step(target, "commit", [...identity, "commit", "-m", "chore: initial commit"]);
  } catch (cause) {
    fs.rmSync(target, { recursive: true, force: true });
    throw cause;
  }
  return { path: target, defaultBranch: INITIAL_BRANCH };
}

async function step(cwd: string, label: string, args: string[]): Promise<void> {
  const result = await tryGit(cwd, ...args);
  if (!result.ok) throw new ClientError(`git ${label} failed: ${result.out}`);
}
