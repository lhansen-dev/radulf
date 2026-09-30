import fs from "node:fs";
import path from "node:path";

/**
 * Per-run cgroup v2 slice (spec 14 L3, Linux only) — the only mechanism that
 * bounds a process *tree*. `ulimit` backstops are deliberately weaker:
 * `-u` (RLIMIT_NPROC) is per-UID so it would starve the server itself, and
 * `-t` is per-process so a fork bomb walks straight past it.
 *
 * Conservative defaults, not user-facing settings (spec: "until proven
 * necessary"). Setup is best-effort: on hosts without a delegated cgroup
 * subtree the writes fail and the run proceeds bounded by the watchdog —
 * real enforcement under load is verification checklist #9.
 */

const CGROUP_ROOT = "/sys/fs/cgroup";

export type CgroupPlan = {
  dir: string;
  /** control-file name → value, written in order. */
  writes: [string, string][];
};

/** Pure assembly of the per-run cgroup config — unit-testable off-Linux. */
export function cgroupPlanForRun(runId: string, root: string = CGROUP_ROOT): CgroupPlan {
  const dir = path.join(root, "radulf", `run-${runId}`);
  return {
    dir,
    writes: [
      ["memory.max", String(8 * 1024 * 1024 * 1024)], // 8 GiB
      ["memory.swap.max", "0"],
      ["pids.max", "2048"],
      ["io.weight", "default 100"], // proportional io pressure, not a hard cap
    ],
  };
}

export type RunCgroup = {
  dir: string;
  procsFile: string;
  /** Shell line each bash invocation runs to join the cgroup. */
  joinLine: string;
};

/** Create and configure the run's cgroup. Returns null off-Linux or when the
 * host has no writable (delegated) cgroup subtree. */
export function setupRunCgroup(runId: string, root: string = CGROUP_ROOT): RunCgroup | null {
  if (process.platform !== "linux") return null;
  const plan = cgroupPlanForRun(runId, root);
  try {
    fs.mkdirSync(plan.dir, { recursive: true });
    const procsFile = path.join(plan.dir, "cgroup.procs");
    const requiredLimits = new Set(["memory.max", "memory.swap.max", "pids.max"]);
    const requiredFiles = [...requiredLimits, "cgroup.kill"];
    if (!fs.existsSync(procsFile) || requiredFiles.some((file) => !fs.existsSync(path.join(plan.dir, file)))) {
      return null;
    }
    // Controllers must be enabled on the parent before limits apply.
    try {
      fs.writeFileSync(
        path.join(path.dirname(plan.dir), "cgroup.subtree_control"),
        "+memory +pids +io",
      );
    } catch {
      // Parent may already delegate them; individual writes below decide.
    }
    for (const [file, value] of plan.writes) {
      const controlFile = path.join(plan.dir, file);
      try {
        // "r+" never creates the file, so an absent optional controller fails
        // this write instead of needing an existence check ahead of it.
        fs.writeFileSync(controlFile, value, { flag: "r+" });
        if (fs.readFileSync(controlFile, "utf8").trim() !== value) throw new Error("cgroup limit mismatch");
      } catch {
        if (requiredLimits.has(file)) return null;
        // A missing optional io controller must not lose memory/pids limits.
      }
    }
    return {
      dir: plan.dir,
      procsFile,
      joinLine: `echo "$$" > '${procsFile}' 2>/dev/null || exit $?`,
    };
  } catch {
    return null;
  }
}

/** Atomically kill every process in a verified run cgroup. Unlike process
 * groups this also catches descendants that created a new session. */
export function killRunCgroupProcesses(dir: string): void {
  fs.writeFileSync(path.join(dir, "cgroup.kill"), "1");
}

/** True only when the kernel reports no remaining member processes. */
export function runCgroupEmpty(dir: string): boolean {
  try {
    return fs.readFileSync(path.join(dir, "cgroup.procs"), "utf8").trim() === "";
  } catch {
    return false;
  }
}

/** Kill everything remaining in the run's cgroup and remove it (run end). */
export function killRunCgroup(dir: string): void {
  try {
    // cgroup.kill (Linux 5.14+) SIGKILLs the whole subtree atomically.
    killRunCgroupProcesses(dir);
  } catch {
    // Best-effort; the pgid reap already ran.
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    // Populated or busy — leave it; next boot can sweep.
  }
}
