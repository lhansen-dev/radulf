import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { DATA_DIR } from "@/db";

const execFileAsync = promisify(execFile);

/**
 * macOS process-tree supervisor. Linux bounds a run's processes with a cgroup
 * or the sandbox PID namespace; macOS has neither, and a process group is no
 * boundary (`setsid`/`setpgid` leave it, and a double fork reparents to
 * launchd). The one thing a process can never shed is its Seatbelt profile:
 * every descendant of a sandboxed command inherits it, across fork, exec and
 * setsid. So the run's processes are identified by asking the kernel about
 * each process's profile (`sandbox_check`), not by ancestry.
 *
 * Each protected run gets two server-owned files in its private root, which
 * the agent can neither write nor delete (only `tmp/` and `cache/` below that
 * root are write-allowed):
 * - `marker` is re-allowed for reads by this run's profile only;
 * - `negative` sits beside it and stays read-denied by this run's profile.
 *
 * A process belongs to the run iff it is sandboxed, may read `marker`, and may
 * not read `negative`. Unsandboxed processes and other profiles that read
 * broadly can read both; other Radulf runs read neither, or both when the
 * scratch root lies outside `$HOME`. `sandbox_check` only answers for paths
 * that exist, so the helper fails closed when either file is missing.
 *
 * Node cannot call `sandbox_check`, so a small C helper does the
 * scan-and-kill loop. It is compiled on first use into `DATA_DIR`, which every
 * run's profile denies, keyed by a hash of its source.
 */

const HELPER_SOURCE = String.raw`
#include <errno.h>
#include <libproc.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <sys/stat.h>
#include <unistd.h>

extern int sandbox_check(pid_t pid, const char *operation, int type, ...);
extern const int SANDBOX_CHECK_NO_REPORT;
#define SANDBOX_FILTER_NONE 0
#define SANDBOX_FILTER_PATH 1
#define MAX_ROUNDS 200

static int readable(pid_t pid, const char *path) {
  return sandbox_check(pid, "file-read-data", SANDBOX_FILTER_PATH | SANDBOX_CHECK_NO_REPORT, path);
}

int main(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: %s <marker> <negative>\n", argv[0]);
    return 64;
  }
  const char *marker = argv[1], *negative = argv[2];
  pid_t self = getpid();
  for (int round = 0; round < MAX_ROUNDS; round++) {
    struct stat st;
    if (stat(marker, &st) != 0 || stat(negative, &st) != 0) {
      fprintf(stderr, "run process marker is missing\n");
      return 3;
    }
    int hint = proc_listallpids(NULL, 0);
    if (hint <= 0) {
      fprintf(stderr, "proc_listallpids: %s\n", strerror(errno));
      return 4;
    }
    int cap = hint + 256;
    pid_t *pids = calloc((size_t)cap, sizeof(pid_t));
    if (!pids) return 4;
    int n = proc_listallpids(pids, cap * (int)sizeof(pid_t));
    if (n <= 0 || n >= cap) {
      free(pids);
      continue;
    }
    // A scan is conclusive only if every listed process was inspected. One
    // that vanished mid-scan may have forked a child the snapshot missed.
    int matched = 0, unclean = 0;
    for (int i = 0; i < n; i++) {
      pid_t pid = pids[i];
      if (pid <= 0 || pid == self) continue;
      struct proc_bsdshortinfo info;
      if (proc_pidinfo(pid, PROC_PIDT_SHORTBSDINFO, 0, &info, sizeof info) != sizeof info) {
        unclean = 1;
        continue;
      }
      if (info.pbsi_status == SZOMB) continue;
      errno = 0;
      int sandboxed = sandbox_check(pid, NULL, SANDBOX_FILTER_NONE);
      if (sandboxed < 0) {
        unclean = 1;
        continue;
      }
      if (sandboxed == 0) continue;
      int marker_ok = readable(pid, marker);
      int negative_ok = readable(pid, negative);
      if (marker_ok < 0 || negative_ok < 0) {
        unclean = 1;
        continue;
      }
      if (marker_ok != 0 || negative_ok == 0) continue;
      matched++;
      if (kill(pid, SIGKILL) != 0 && errno != ESRCH) {
        fprintf(stderr, "cannot kill run process %d: %s\n", pid, strerror(errno));
        free(pids);
        return 2;
      }
    }
    free(pids);
    if (matched == 0 && !unclean) return 0;
    if (matched > 0) usleep(10000);
  }
  fprintf(stderr, "run processes still alive after %d scans\n", MAX_ROUNDS);
  return 1;
}
`;

let helper: Promise<string> | undefined;

/** Compile the helper once per server process (and once per source change). */
function seatbeltReaperBinary(): Promise<string> {
  helper ??= (async () => {
    const hash = crypto.createHash("sha256").update(HELPER_SOURCE).digest("hex").slice(0, 12);
    const dir = path.join(DATA_DIR, "bin");
    const binary = path.join(dir, `seatbelt-reaper-${hash}`);
    if (fs.existsSync(binary)) return binary;
    // `cc` is a shim that opens a GUI installer when the Command Line Tools
    // are missing, so check for them first and fail with an actionable error.
    try {
      await execFileAsync("xcode-select", ["-p"]);
    } catch {
      throw new Error(
        "sandboxed runs on macOS need the Xcode Command Line Tools (xcode-select --install) " +
          "to build the run process supervisor",
      );
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const work = fs.mkdtempSync(path.join(dir, "build-"));
    try {
      const source = path.join(work, "seatbelt-reaper.c");
      const output = path.join(work, "seatbelt-reaper");
      fs.writeFileSync(source, HELPER_SOURCE);
      await execFileAsync("cc", ["-O2", "-Wall", "-o", output, source]);
      fs.renameSync(output, binary);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
    return binary;
  })();
  // A failed build (e.g. tools installed later) is retried on the next call.
  helper.catch(() => {
    helper = undefined;
  });
  return helper;
}

export type SeatbeltProcessMarkers = { marker: string; negative: string };

/** Create the run's marker pair in its private root (see the module doc). */
export function createSeatbeltProcessMarkers(root: string): SeatbeltProcessMarkers {
  const marker = path.join(root, "process-marker");
  const negative = path.join(root, "process-negative");
  fs.writeFileSync(marker, "", { mode: 0o400 });
  fs.writeFileSync(negative, "", { mode: 0o400 });
  return { marker, negative };
}

/** SIGKILL every process running under this run's profile, and resolve only
 * once a full scan finds none. Throws when that cannot be shown. */
export async function reapSeatbeltRun(markers: SeatbeltProcessMarkers): Promise<void> {
  const binary = await seatbeltReaperBinary();
  try {
    await execFileAsync(binary, [markers.marker, markers.negative], { timeout: 30_000 });
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr?.trim();
    throw new Error(`cannot prove command quiescence: ${stderr || (e as Error).message}`);
  }
}
