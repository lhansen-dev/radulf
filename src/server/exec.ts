import { execFile, type ExecFileException } from "node:child_process";

// A process wedged deep in a blocking syscall can ignore SIGTERM; escalate to
// SIGKILL this long after if it's still alive.
const KILL_GRACE_MS = 5_000;

export type ExecBoundedOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBuffer: number;
};

export type ExecBoundedResult = {
  /** execFile's callback error: a non-zero exit, a spawn failure, or our kill. */
  err: ExecFileException | null;
  stdout: string;
  stderr: string;
  /** True when `err` is the result of our own SIGTERM/SIGKILL, so the caller
   * can name the timeout instead of surfacing an opaque "Command failed". */
  timedOut: boolean;
};

/**
 * Run `bin ...args` with a bounded lifetime: SIGTERM at `timeoutMs`, SIGKILL at
 * `timeoutMs + KILL_GRACE_MS` if it's still alive. Not built on
 * `promisify(execFile)`'s own `timeout` option because that only ever sends one
 * signal — a hung child (credential-helper prompt on stdin, corrupt lock file,
 * dead network mount) must not be able to freeze the whole app, since the
 * orchestrator runs exactly one card at a time globally.
 *
 * Never rejects: the callback's error, if any, comes back alongside whatever
 * the child wrote, and each caller shapes its own contract from that.
 */
export function execBounded(
  bin: string,
  args: string[],
  options: ExecBoundedOptions
): Promise<ExecBoundedResult> {
  return new Promise((resolve) => {
    let timedOut = false;
    const child = execFile(
      bin,
      args,
      {
        encoding: "utf8" as const,
        maxBuffer: options.maxBuffer,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: options.env } : {}),
      },
      (err, stdout, stderr) => {
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        resolve({ err, stdout, stderr, timedOut });
      }
    );
    // Nothing run through here is ever meant to read stdin. Closing it makes a
    // credential helper (or gh) that decides to prompt fail immediately instead
    // of blocking on a read that will never be answered.
    child.stdin?.end();
    const termTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);
    const killTimer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs + KILL_GRACE_MS);
  });
}
