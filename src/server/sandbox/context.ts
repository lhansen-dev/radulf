import fs from "node:fs";
import path from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { DATA_DIR, type DiskLimitMechanism } from "@/db";
import type { Settings } from "../settings";
import { agentEnv } from "../harness/types";
import { setupRunCgroup, killRunCgroup, type RunCgroup } from "./cgroup";
import { detectMacDiskMechanism } from "./diskWatchdog";
import { buildRunSandboxConfig, resolveGitCommonDir } from "./srt";

/**
 * Per-run sandbox context (spec 14, resolved design question 4): ONE factory
 * owns the run-private filesystem layout, the agent env, and the bash
 * command preamble, threaded through `RunHarnessOpts.runContext` into
 * `createRalphSession`'s spawn hook. Each run entry point (planner, loop,
 * evaluator) calls the factory once and `cleanup()`s in a `finally`.
 */

/** Root for per-run private dirs — a sibling of data/ like worktrees/, so the
 * L1 policy's blanket "deny data/" needs no carve-outs. */
export function runScratchRoot(): string {
  return path.join(path.dirname(DATA_DIR), "runtmp");
}

export type RunSandboxContext = {
  runId: string;
  /** The run's private root: <runtmp>/<runId>/ (tmp/, cache/). */
  root: string;
  /** Run-private TMPDIR — created at run start, deleted at run end. */
  tmpdir: string;
  /** Run-private package-manager cache root the host never consumes. */
  cacheRoot: string;
  /** File where each bash invocation records its process-group id. */
  pgidFile: string;
  /** The allowlist agent env for this run (spec 14 L3). */
  env: NodeJS.ProcessEnv;
  /** Preamble prepended to every agent bash command (ulimits, pgid record,
   * cgroup join). Runs inside the same shell as the command. */
  commandPrefix: string;
  /** The real disk bound in force — stamped on the run row. */
  diskLimitMechanism: DiskLimitMechanism;
  /** Layer 1 (spec 14 Phase 6): this run's srt filesystem+network policy,
   * for `wrapWithSandbox`'s per-call `customConfig`. Present only when the
   * caller passed a `cwd` and `sandboxEnabled` is on — absent means "do not
   * L1-wrap this run's bash," which callers must only allow when
   * `sandboxEnabled` is deliberately off (never silently). */
  srtConfig?: SandboxRuntimeConfig;
  /** Kill every recorded process group; returns pgids still alive after. */
  reap(): Promise<number[]>;
  /** Reap, tear down the cgroup, and delete the run-private root. */
  cleanup(): Promise<void>;
};

const REAP_RETRIES = 10;
const REAP_RETRY_MS = 100;

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** True while any process remains in the group. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readPgids(pgidFile: string): number[] {
  let raw = "";
  try {
    raw = fs.readFileSync(pgidFile, "utf8");
  } catch {
    return [];
  }
  const ids = new Set<number>();
  for (const line of raw.split("\n")) {
    const n = Number.parseInt(line.trim(), 10);
    // Guard: never a signal to pid 0/1/-1 territory. Recorded pgids are the
    // detached bash shells' own pids, never the server's.
    if (Number.isInteger(n) && n > 1 && n !== process.pid) ids.add(n);
  }
  return [...ids];
}

/**
 * Kill every recorded process group and verify each is empty (spec 14 L3
 * process-group reaping). Must run BEFORE the repo integrity check and before
 * merge — a surviving process can plant hooks after a check that already
 * passed. Best-effort against a process that re-execs into a new session; on
 * Linux the cgroup kill sweeps those too.
 */
export async function reapProcessGroups(pgidFile: string): Promise<number[]> {
  const pgids = readPgids(pgidFile);
  const leftover: number[] = [];
  for (const pgid of pgids) {
    for (let attempt = 0; groupAlive(pgid); attempt++) {
      if (attempt >= REAP_RETRIES) {
        leftover.push(pgid);
        break;
      }
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // Group vanished between the check and the kill.
      }
      await sleep(REAP_RETRY_MS);
    }
  }
  return leftover;
}

/**
 * The resource-limit preamble (spec 14 L3). Only `-t` (CPU seconds per
 * process) and `-f` (max file size) are set:
 * - `ulimit -u` (RLIMIT_NPROC) is per real UID, not per tree — Radulf runs as
 *   the same user as the agent, so it would starve the server. NEVER set it.
 * - `ulimit -v` (RLIMIT_AS) breaks Go toolchains, JVMs, and arena allocators
 *   that reserve address space they never touch. NEVER set it.
 * Both are recorded here so they are not reintroduced. The per-tree bound is
 * the Linux cgroup; macOS is bounded by the disk watchdog + wall clocks.
 */
export function buildCommandPrefix(pgidFile: string, cgroup: RunCgroup | null): string {
  const lines = [
    "ulimit -t 900 2>/dev/null || true",
    "ulimit -f 8388608 2>/dev/null || true", // 512-byte blocks → 4 GiB max file
    `echo "$$" >> '${pgidFile}' 2>/dev/null || true`,
  ];
  if (cgroup) lines.push(cgroup.joinLine);
  return lines.join("\n");
}

export function createRunSandbox(
  runId: string,
  opts?: { cwd?: string; s?: Settings },
): RunSandboxContext {
  const root = path.join(runScratchRoot(), runId);
  const tmpdir = path.join(root, "tmp");
  const cacheRoot = path.join(root, "cache");
  // The pgid file MUST live inside an L1 allowWrite root (the run's private
  // TMPDIR is one — see buildFilesystemConfig): the commandPrefix's
  // `echo "$$" >> pgids` runs INSIDE the sandbox, so a pgid file at the run
  // root (not writable) is silently denied, leaving process-group reaping
  // (1f) inert for every sandboxed run. Keeping it under $TMPDIR fixes that;
  // agent tampering grants no capability the agent's bash doesn't already have.
  const pgidFile = path.join(tmpdir, "pgids");
  fs.mkdirSync(tmpdir, { recursive: true });
  fs.mkdirSync(cacheRoot, { recursive: true });
  fs.writeFileSync(pgidFile, "", { flag: "a" });

  const cgroup = setupRunCgroup(runId);
  const env = agentEnv({ tmpdir, cacheRoot });

  // Layer 1 (spec 14 Phase 6): built here (not in pi.ts) because it needs
  // the worktree's shared .git dir, which requires a git call this
  // constructor is already the synchronous, run-start place for. Only
  // built when sandboxing is on — an operator who turned it off should not
  // pay for the git call, and pi.ts's absence-means-unsandboxed contract
  // depends on this being genuinely absent rather than unused.
  const sandboxEnabled = opts?.s?.sandboxEnabled ?? true;
  const srtConfig =
    opts?.cwd && sandboxEnabled
      ? buildRunSandboxConfig({
          worktree: opts.cwd,
          gitCommonDir: resolveGitCommonDir(opts.cwd),
          tmpdir,
          cacheRoot,
          networkAllowlistText: opts.s?.sandboxNetworkAllowlist ?? "",
          weakerIsolationForGoTls: opts.s?.sandboxWeakerIsolationForGoTls ?? false,
        })
      : undefined;

  // The real disk bound: the Linux cgroup where present; otherwise the genuine
  // macOS ceiling when the worktree lives on an APFS quota volume (the README's
  // hardened option), else the always-on watchdog backstop. Detected on the
  // worktree — where the agent's writes land — not the run's scratch root.
  const diskLimitMechanism: DiskLimitMechanism = cgroup
    ? "cgroup"
    : detectMacDiskMechanism(opts?.cwd ?? root);

  const reap = () => reapProcessGroups(pgidFile);
  return {
    runId,
    root,
    tmpdir,
    cacheRoot,
    pgidFile,
    env,
    commandPrefix: buildCommandPrefix(pgidFile, cgroup),
    diskLimitMechanism,
    srtConfig,
    reap,
    async cleanup() {
      try {
        await reap();
      } catch {
        // Cleanup must never throw past the run's finally.
      }
      if (cgroup) killRunCgroup(cgroup.dir);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
