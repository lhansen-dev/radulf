import fs from "node:fs";
import path from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { db, DATA_DIR, repos, type DiskLimitMechanism } from "@/db";
import { sleep } from "@/shared/sleep";
import type { Settings } from "../settings";
import { browsableRoot } from "../folderBrowser";
import { agentEnv } from "../harness/types";
import {
  setupRunCgroup,
  killRunCgroup,
  killRunCgroupProcesses,
  runCgroupEmpty,
  type RunCgroup,
} from "./cgroup";
import { detectMacDiskMechanism } from "./diskWatchdog";
import { buildRunSandboxConfig, resolveGitCommonDir } from "./srt";
import { createSerialQueue } from "./serialQueue";
import { createSeatbeltProcessMarkers, reapSeatbeltRun } from "./seatbeltReaper";

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
  /** True when this run actually applied `sandboxWeakerIsolationForGoTls`
   * (spec 14 opt-in). Callers must emit `sandbox.weaker_isolation_enabled`
   * themselves, once their own `runs` row exists — `createRunSandbox` runs
   * before that insert (PLAN.md Phase 18.1: emitting the event here raced
   * ahead of `events.run_id`'s FK and crashed run start). */
  weakerIsolationEnabled: boolean;
  /** Mark that an attacker-controlled command has started. */
  markCommandStarted(): void;
  /** Record a detached shell group from the trusted parent process. */
  trackProcessGroup(pgid: number): void;
  /** Serialize bash and in-process file tools for this run. Combined with
   * pre-file-tool reaping, this removes every attacker-controlled process
   * that could mutate a checked pathname before the SDK opens it. */
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
  /** Kill every recorded process group; returns pgids still alive after. */
  reap(): Promise<number[]>;
  /** Reap, tear down the cgroup, and delete the run-private root. */
  cleanup(): Promise<void>;
};

const REAP_RETRIES = 10;
const REAP_RETRY_MS = 100;

export function processTreeSupervisorAvailable(
  platform: NodeJS.Platform,
  hasSandboxPolicy: boolean,
  hasCgroup: boolean,
): boolean {
  return hasCgroup || (platform === "linux" && hasSandboxPolicy);
}

/** True while any process remains in the group. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill every trusted-parent-recorded process group and verify each is empty.
 * The IDs must never come from an agent-writable file: an attacker could
 * truncate that ledger immediately after starting a symlink flipper.
 */
export async function reapProcessGroups(pgids: Iterable<number>): Promise<number[]> {
  // Kill every live group before each wait, so N survivors cost one retry
  // interval rather than N of them.
  let live = [...pgids].filter(groupAlive);
  for (let attempt = 0; live.length > 0 && attempt < REAP_RETRIES; attempt++) {
    for (const pgid of live) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // Group vanished between the check and the kill.
      }
    }
    await sleep(REAP_RETRY_MS);
    live = live.filter(groupAlive);
  }
  return live;
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
export function buildCommandPrefix(cgroup: RunCgroup | null): string {
  const lines = [
    ...(cgroup ? [cgroup.joinLine] : []),
    "ulimit -t 900 2>/dev/null || true",
    "ulimit -f 8388608 2>/dev/null || true", // 512-byte blocks → 4 GiB max file
  ];
  return lines.join("\n");
}

export async function createRunSandbox(
  runId: string,
  opts?: { cwd?: string; s?: Settings },
): Promise<RunSandboxContext> {
  const root = path.join(runScratchRoot(), runId);
  const tmpdir = path.join(root, "tmp");
  const cacheRoot = path.join(root, "cache");
  fs.mkdirSync(tmpdir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  fs.chmodSync(tmpdir, 0o700);
  fs.chmodSync(cacheRoot, 0o700);
  const cgroup = setupRunCgroup(runId);
  const env = agentEnv({ tmpdir, cacheRoot });

  // Layer 1 (spec 14 Phase 6): built here (not in pi.ts) because it needs
  // the worktree's shared .git dir, which requires a git call this
  // constructor is already the run-start place for. Only built when
  // sandboxing is on — an operator who turned it off should not
  // pay for the git call, and pi.ts's absence-means-unsandboxed contract
  // depends on this being genuinely absent rather than unused.
  const sandboxEnabled = opts?.s?.sandboxEnabled ?? true;
  const weakerIsolationForGoTls = opts?.s?.sandboxWeakerIsolationForGoTls ?? false;
  const seatbeltMarkers =
    opts?.cwd && sandboxEnabled && process.platform === "darwin"
      ? createSeatbeltProcessMarkers(root)
      : undefined;
  const srtConfig =
    opts?.cwd && sandboxEnabled
      ? buildRunSandboxConfig({
          worktree: opts.cwd,
          gitCommonDir: await resolveGitCommonDir(opts.cwd),
          tmpdir,
          cacheRoot,
          repositoryRoots: [
            browsableRoot(opts.s?.folderBrowserRoot ?? ""),
            ...(fs.existsSync("/repos") ? ["/repos"] : []),
            ...db.select({ path: repos.path }).from(repos).all().map((repo) => repo.path),
          ],
          cgroupProcsFile: cgroup?.procsFile,
          processMarkers: seatbeltMarkers,
          networkAllowlistText: opts.s?.sandboxNetworkAllowlist ?? "",
          weakerIsolationForGoTls,
        })
      : undefined;
  // Spec 14 opt-in has a residual exfil channel (see buildRunSandboxConfig's
  // doc comment on `weakerIsolationForGoTls`) — surface every run that
  // actually applies it, once, so it's visible in server logs and on the
  // card detail page without an operator having to know to look. The event
  // itself is NOT emitted here (PLAN.md Phase 18.1) — this runs before the
  // caller's own `runs` row exists, and `events.run_id` is a real FK; the
  // caller emits it once that insert has landed. The console warning has no
  // such dependency, so it stays here.
  const weakerIsolationEnabled = Boolean(srtConfig && weakerIsolationForGoTls);
  if (weakerIsolationEnabled) {
    console.warn(
      `[radulf] run ${runId} starting with weaker network isolation (trustd allowed) — see docs/SANDBOXING.md`,
    );
  }

  // Cgroups enforce memory and process limits, but cgroup v2 has no disk-space
  // controller. Stamp the actual disk mechanism independently.
  const diskLimitMechanism: DiskLimitMechanism = await detectMacDiskMechanism(opts?.cwd ?? root);

  const processGroups = new Set<number>();
  let commandStarted = false;
  const reap = async (): Promise<number[]> => {
    const survivors = new Set(await reapProcessGroups(processGroups));
    for (const pgid of processGroups) {
      if (!survivors.has(pgid)) processGroups.delete(pgid);
    }

    if (cgroup) {
      for (let attempt = 0; !runCgroupEmpty(cgroup.dir); attempt += 1) {
        if (attempt >= REAP_RETRIES) {
          throw new Error("run cgroup still contains processes after reap");
        }
        killRunCgroupProcesses(cgroup.dir);
        await sleep(REAP_RETRY_MS);
      }
      for (const pgid of processGroups) {
        if (!groupAlive(pgid)) processGroups.delete(pgid);
      }
    } else if (commandStarted && seatbeltMarkers) {
      await reapSeatbeltRun(seatbeltMarkers);
    } else if (
      commandStarted &&
      sandboxEnabled &&
      !processTreeSupervisorAvailable(process.platform, srtConfig !== undefined, cgroup !== null)
    ) {
      // A child may call setsid and leave its original process group. Without
      // a cgroup or Linux sandbox PID namespace there is no complete
      // process-tree boundary. Protected runs therefore never cross into a
      // privileged file tool, repository mutation, or artifact write after
      // command execution. An explicit sandbox opt-out keeps its documented
      // unsafe behavior.
      throw new Error(
        "cannot prove command quiescence without a verified process-tree supervisor",
      );
    }
    return [...processGroups];
  };
  const runExclusive = createSerialQueue();
  return {
    runId,
    root,
    tmpdir,
    cacheRoot,
    env,
    commandPrefix: buildCommandPrefix(cgroup),
    diskLimitMechanism,
    srtConfig,
    weakerIsolationEnabled,
    markCommandStarted() {
      commandStarted = true;
    },
    trackProcessGroup(pgid: number) {
      if (Number.isInteger(pgid) && pgid > 1 && pgid !== process.pid) {
        processGroups.add(pgid);
      }
    },
    runExclusive,
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
