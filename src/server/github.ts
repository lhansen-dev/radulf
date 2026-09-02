/**
 * github.ts — spec 15's `gh` integration, and the whole of it.
 *
 * Radulf does not implement a GitHub login. It shells out to `gh` and requires
 * that `gh` is already authenticated, which is the same position `make login`
 * takes for the three subscription providers: interactive OAuth belongs in the
 * operator's own terminal, not in a flow this app drives. A token setting and a
 * self-hosted device flow are both recorded in spec 15 as deferred — either can
 * be added later without changing anything here.
 *
 * NOT model-reachable, permanently. No tool binding exists for these functions
 * and none may be added: this module is what lets an approved diff leave the
 * machine, so its only caller is the host-side review path, downstream of a
 * human's approval. Spec 14's containment is untouched — `git push` still dies
 * inside the sandbox over both HTTPS and SSH, and `~/.config/gh` is still on
 * its deny list, so an agent can neither push nor read the credential this
 * module depends on.
 */
import { execFile } from "node:child_process";

const GH_TIMEOUT_MS = 30_000;
const GH_PR_TIMEOUT_MS = 2 * 60_000;
/** Availability is stable within a session but not across one — the operator
 * fixes auth in a terminal while the app runs. Cache briefly so the UI can ask
 * on every render, and let `invalidateGithubStatus` clear it the moment a
 * delivery fails, so the fix is picked up without a restart. */
const STATUS_TTL_MS = 30_000;

export type GithubStatus =
  | { ok: true }
  | { ok: false; reason: "missing"; detail: string }
  | { ok: false; reason: "unauthenticated"; detail: string };

function run(
  args: string[],
  options: { cwd?: string; timeoutMs: number },
): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    let timedOut = false;
    const child = execFile(
      "gh",
      args,
      {
        encoding: "utf8" as const,
        maxBuffer: 8 * 1024 * 1024,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        env: {
          ...process.env,
          // gh renders progress and colour differently under a TTY; force the
          // plain, parseable form regardless of how the server was started.
          NO_COLOR: "1",
          GH_PROMPT_DISABLED: "1",
        },
      },
      (err, stdout, stderr) => {
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        const out = ((stdout ?? "") + (stderr ?? "")).trim();
        if (err) {
          resolve({
            ok: false,
            out: timedOut ? `gh ${args[0]} timed out after ${options.timeoutMs}ms` : out || err.message,
          });
        } else {
          resolve({ ok: true, out });
        }
      },
    );
    // gh must never sit waiting on input it will not get.
    child.stdin?.end();
    const termTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);
    const killTimer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs + 5_000);
  });
}

let cached: { at: number; status: GithubStatus } | null = null;

/** Drop the cached availability check. Called when a delivery fails, so an
 * operator who fixes `gh auth` in a terminal and retries is not told for
 * another 30 seconds that nothing has changed. */
export function invalidateGithubStatus(): void {
  cached = null;
}

/**
 * Is `gh` installed and authenticated? The two failures are distinguished
 * because the operator's next action differs: install a tool, or run a login.
 */
export async function githubStatus(): Promise<GithubStatus> {
  if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.status;
  const version = await run(["--version"], { timeoutMs: GH_TIMEOUT_MS });
  let status: GithubStatus;
  if (!version.ok) {
    status = {
      ok: false,
      reason: "missing",
      detail: "the GitHub CLI (`gh`) is not installed or not on PATH",
    };
  } else {
    const auth = await run(["auth", "status"], { timeoutMs: GH_TIMEOUT_MS });
    status = auth.ok
      ? { ok: true }
      : {
          ok: false,
          reason: "unauthenticated",
          detail: "`gh` is not authenticated — run `gh auth login` in a terminal",
        };
  }
  cached = { at: Date.now(), status };
  return status;
}

/**
 * Open a pull request for an already-pushed branch.
 *
 * `draft` is decided by whether *this particular approval* came from a human
 * or from auto-approve — not by the card's flags. That keeps "a non-draft PR
 * from Radulf was seen by a human" true by construction (spec 15).
 */
export async function createPullRequest(options: {
  worktreePath: string;
  baseBranch: string;
  branch: string;
  title: string;
  body: string;
  draft: boolean;
}): Promise<{ ok: boolean; url?: string; error?: string }> {
  const args = [
    "pr",
    "create",
    "--base",
    options.baseBranch,
    "--head",
    options.branch,
    "--title",
    options.title,
    "--body",
    options.body,
  ];
  if (options.draft) args.push("--draft");
  const result = await run(args, {
    cwd: options.worktreePath,
    timeoutMs: GH_PR_TIMEOUT_MS,
  });
  if (!result.ok) return { ok: false, error: result.out || "gh pr create failed" };
  // gh prints the PR URL on success; take the last one it emits so a leading
  // informational line cannot be mistaken for the result.
  const urls = result.out.match(/https:\/\/\S+\/pull\/\d+/g);
  return { ok: true, ...(urls ? { url: urls[urls.length - 1] } : {}) };
}
