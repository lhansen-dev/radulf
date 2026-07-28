import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { DiskLimitMechanism } from "@/db";

const execFileAsync = promisify(execFile);

/**
 * Polling disk watchdog + ballast file (spec 14 L3) — the DEFAULT macOS disk
 * bound (no operator setup, cannot fail closed on a fresh install) and a
 * cross-platform backstop beside the Linux cgroup. Reactive, not preventive:
 * a writer can land several GB between samples on NVMe, so the thresholds
 * carry real headroom (tune from verification checklist #9). The hardened
 * alternative — an APFS volume with a quota — is documented in the README.
 */

/** Fail the run when its private dirs grow past this (bytes). */
export const DEFAULT_MAX_RUN_BYTES = 16 * 1024 * 1024 * 1024; // 16 GiB
/** Fail the run when the volume's free space drops below this (bytes). */
export const DEFAULT_MIN_FREE_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB
export const DEFAULT_SAMPLE_INTERVAL_MS = 5_000;
/** Dead weight deleted on disk pressure so the machine stays usable. */
export const BALLAST_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

/** Sum of `du` for every existing path, in bytes. */
export async function sampleUsageBytes(paths: string[]): Promise<number> {
  const existing = paths.filter((p) => fs.existsSync(p));
  if (existing.length === 0) return 0;
  try {
    const { stdout } = await execFileAsync("du", ["-sk", ...existing]);
    return stdout
      .split("\n")
      .filter(Boolean)
      .reduce((sum, line) => sum + Number.parseInt(line, 10) * 1024, 0);
  } catch {
    return 0; // A vanished path mid-run must not trip the watchdog.
  }
}

export async function freeBytes(onPath: string): Promise<number | null> {
  try {
    const s = await fs.promises.statfs(onPath);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** Create the ballast file if missing (allocated, not sparse — zeros are
 * written so the space is really reserved). Async and best-effort so the
 * multi-GB write never blocks the server; callers fire-and-forget. */
export async function ensureBallast(
  ballastPath: string,
  bytes: number = BALLAST_BYTES,
): Promise<void> {
  try {
    const existing = await fs.promises.stat(ballastPath).catch(() => null);
    if (existing && existing.size >= bytes) return;
    await fs.promises.mkdir(path.dirname(ballastPath), { recursive: true });
    const chunk = Buffer.alloc(64 * 1024 * 1024);
    const handle = await fs.promises.open(ballastPath, "w");
    try {
      for (let written = 0; written < bytes; written += chunk.length) {
        await handle.write(chunk, 0, Math.min(chunk.length, bytes - written));
      }
    } finally {
      await handle.close();
    }
  } catch {
    // Best-effort: a host too full to hold ballast still gets the watchdog.
  }
}

export function releaseBallast(ballastPath: string): void {
  fs.rmSync(ballastPath, { force: true });
}

function plistInt(xml: string, key: string): number | null {
  // diskutil -plist emits `<key>K</key>\n\t<integer>N</integer>`; parse the
  // integer that immediately follows the key rather than pulling in a plist lib.
  const m = xml.match(
    new RegExp(`<key>${key}</key>\\s*<integer>(\\d+)</integer>`),
  );
  return m ? Number.parseInt(m[1], 10) : null;
}

/**
 * Classify a `diskutil info -plist` document (pure — the testable core of the
 * detector below). An APFS volume created with `diskutil apfs addVolume …
 * -quota <size>` (the README's hardened option) reports its quota as
 * `TotalSize`, strictly below the shared `APFSContainerSize`; a plain volume
 * reports the two equal. There is no dedicated "quota" plist key — this size
 * relationship is the only signal diskutil exposes (verified live against a
 * real quota volume, 2026-07-22). Anything unparseable → `watchdog`.
 */
export function mechanismFromDiskutilPlist(xml: string): DiskLimitMechanism {
  const total = plistInt(xml, "TotalSize");
  const container = plistInt(xml, "APFSContainerSize");
  if (total && container && total < container) return "apfs-quota";
  return "watchdog";
}

/**
 * The real disk bound in force for a run whose writes land under `dirPath`
 * (spec 14 L3 / verification checklist #9). macOS only — Linux's real bound is
 * the cgroup, resolved by the caller before this is consulted. When a real
 * APFS quota bounds the run we stamp `apfs-quota` so the run row reflects the
 * genuine ceiling instead of the always-present watchdog backstop. Best-effort:
 * anything unparseable falls back to `watchdog`, which is never wrong (the
 * watchdog runs regardless).
 */
export function detectMacDiskMechanism(dirPath: string): DiskLimitMechanism {
  if (process.platform !== "darwin") return "watchdog";
  // Hermetic + fast under test: no per-run diskutil shell-out. The pure
  // parser above carries the detection logic under test; live behavior is
  // verified out of band (checklist #9).
  if (process.env.NODE_ENV === "test") return "watchdog";
  try {
    const xml = execFileSync("diskutil", ["info", "-plist", dirPath], {
      encoding: "utf8",
      timeout: 5_000,
    });
    return mechanismFromDiskutilPlist(xml);
  } catch {
    // No diskutil, not APFS, or an unreadable path — the watchdog still bounds it.
    return "watchdog";
  }
}

export type DiskWatchdogOpts = {
  /** Dirs whose combined size is bounded (worktree + run tmp + run cache). */
  paths: string[];
  /** Called once, with a human-readable reason, when a bound is exceeded. */
  onTrip: (reason: string) => void;
  maxRunBytes?: number;
  minFreeBytes?: number;
  intervalMs?: number;
  /** Deleted when the free-space bound trips, before onTrip fires. */
  ballastPath?: string;
};

export function startDiskWatchdog(opts: DiskWatchdogOpts): { stop(): void } {
  const maxRunBytes = opts.maxRunBytes ?? DEFAULT_MAX_RUN_BYTES;
  const minFreeBytes = opts.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES;
  let stopped = false;
  let sampling = false;

  const timer = setInterval(async () => {
    if (stopped || sampling) return;
    sampling = true;
    try {
      const used = await sampleUsageBytes(opts.paths);
      if (stopped) return;
      if (used > maxRunBytes) {
        trip(
          `disk watchdog: run is using ${(used / 1e9).toFixed(1)} GB, over the ` +
            `${(maxRunBytes / 1e9).toFixed(0)} GB per-run bound`,
        );
        return;
      }
      const free = opts.paths.length ? await freeBytes(opts.paths[0]) : null;
      if (stopped || free === null) return;
      if (free < minFreeBytes) {
        if (opts.ballastPath) releaseBallast(opts.ballastPath);
        trip(
          `disk watchdog: volume free space is ${(free / 1e9).toFixed(1)} GB, under the ` +
            `${(minFreeBytes / 1e9).toFixed(0)} GB floor`,
        );
      }
    } finally {
      sampling = false;
    }
  }, opts.intervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS);
  timer.unref?.();

  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  const trip = (reason: string) => {
    stop();
    opts.onTrip(reason);
  };
  return { stop };
}
