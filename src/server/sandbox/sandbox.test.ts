import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { agentEnv, AGENT_GIT_IDENTITY } from "../harness/types";
import { SETTING_DEFAULTS, type Settings } from "../settings";
import { cgroupPlanForRun } from "./cgroup";
import {
  mechanismFromDiskutilPlist,
  sampleUsageBytes,
  startDiskWatchdog,
} from "./diskWatchdog";

function testSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...SETTING_DEFAULTS, ...overrides } as Settings;
}

// context.ts resolves its scratch root from DATA_DIR at import time — point it
// at a throwaway dir before loading it.
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-sandbox-"));
process.env.RADULF_DATA_DIR = path.join(testDataDir, "data");
const { buildCommandPrefix, createRunSandbox, reapProcessGroups, readPgids, runScratchRoot } =
  await import("./context");

const execFileAsync = promisify(execFile);

afterAll(() => {
  fs.rmSync(testDataDir, { recursive: true, force: true });
  delete process.env.RADULF_DATA_DIR;
});

describe("agentEnv — spec 14 L3 allowlist", () => {
  it("contains only allowlisted keys and never a secret from the launching shell", () => {
    process.env.FAKE_TOKEN = "leaked-cloud-credential";
    process.env.RADULF_AUTH_SECRET = "cookie-forging-key";
    process.env.RADULF_AUTH_PASSWORD_HASH = "hash";
    process.env.SSH_AUTH_SOCK = "/tmp/ssh-agent.sock";
    process.env.OPENROUTER_API_KEY = "sk-or-secret";
    try {
      const env = agentEnv();
      // Excluded BY CONSTRUCTION — not by enumeration.
      expect(env.FAKE_TOKEN).toBeUndefined();
      expect(env.RADULF_AUTH_SECRET).toBeUndefined();
      expect(env.RADULF_AUTH_PASSWORD_HASH).toBeUndefined();
      expect(env.OPENROUTER_API_KEY).toBeUndefined();
      // SSH_AUTH_SOCK's absence is a security invariant (socket policy):
      // denying ~/.ssh prevents reading the key; dropping the agent socket
      // prevents USING it without reading it. Restoring it is a regression.
      expect(env.SSH_AUTH_SOCK).toBeUndefined();

      const allowedPattern = /^(PATH|HOME|TMPDIR|LANG|LC_.*|TERM|npm_config_.*|YARN_.*|XDG_CACHE_HOME|GIT_.*)$/;
      for (const key of Object.keys(env)) {
        expect(key, `unexpected agent env key: ${key}`).toMatch(allowedPattern);
      }
      expect(env.TERM).toBe("dumb");
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      delete process.env.FAKE_TOKEN;
      delete process.env.RADULF_AUTH_SECRET;
      delete process.env.RADULF_AUTH_PASSWORD_HASH;
      delete process.env.SSH_AUTH_SOCK;
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it("hardens git: no global/system config, no askpass, no ssh, constant identity", () => {
    const env = agentEnv();
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.GIT_CONFIG_SYSTEM).toBe("/dev/null");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_ASKPASS).toBe("/bin/false");
    expect(env.GIT_SSH_COMMAND).toBe("/bin/false");
    // Identity must exist because /dev/null wiped the user's gitconfig.
    expect(env.GIT_AUTHOR_NAME).toBe(AGENT_GIT_IDENTITY.GIT_AUTHOR_NAME);
    expect(env.GIT_COMMITTER_EMAIL).toBe(AGENT_GIT_IDENTITY.GIT_COMMITTER_EMAIL);
  });

  it("agent git in a real repo sees no user config and cannot prompt", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-gitenv-"));
    try {
      const env = { ...agentEnv(), PATH: process.env.PATH } as NodeJS.ProcessEnv;
      await execFileAsync("git", ["-C", dir, "init"], { env });
      fs.writeFileSync(path.join(dir, "f.txt"), "x");
      await execFileAsync("git", ["-C", dir, "add", "."], { env });
      // Commit works purely off GIT_AUTHOR_*/GIT_COMMITTER_* (checklist #4).
      await execFileAsync("git", ["-C", dir, "commit", "-m", "t"], { env });
      const { stdout } = await execFileAsync(
        "git",
        ["-C", dir, "log", "-1", "--format=%an <%ae>"],
        { env },
      );
      expect(stdout.trim()).toBe(
        `${AGENT_GIT_IDENTITY.GIT_AUTHOR_NAME} <${AGENT_GIT_IDENTITY.GIT_AUTHOR_EMAIL}>`,
      );
      // No user/system config reaches agent git.
      const configs = await execFileAsync(
        "git",
        ["-C", dir, "config", "--list", "--show-origin"],
        { env },
      );
      expect(configs.stdout).not.toMatch(/\.gitconfig/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("points TMPDIR and package caches at the run-private roots", () => {
    const env = agentEnv({ tmpdir: "/runs/x/tmp", cacheRoot: "/runs/x/cache" });
    expect(env.TMPDIR).toBe("/runs/x/tmp");
    expect(env.npm_config_cache).toBe("/runs/x/cache/npm");
    expect(env.YARN_CACHE_FOLDER).toBe("/runs/x/cache/yarn");
    expect(env.XDG_CACHE_HOME).toBe("/runs/x/cache/xdg");
    expect(env.npm_config_cache!.startsWith(os.homedir())).toBe(false);
    // Go caches default under $HOME (write-denied by L1); redirect them to the
    // run cache root so a sandboxed `go mod download` needs no $HOME re-allow.
    expect(env.GOPATH).toBe("/runs/x/cache/go");
    expect(env.GOMODCACHE).toBe("/runs/x/cache/go/pkg/mod");
    expect(env.GOCACHE).toBe("/runs/x/cache/go-build");
    expect(env.GOFLAGS).toBe("-modcacherw");
    expect(env.GOCACHE!.startsWith(os.homedir())).toBe(false);
    // Lifecycle scripts disabled by default (gate detection never trusts this).
    expect(env.npm_config_ignore_scripts).toBe("true");
  });
});

describe("createRunSandbox", () => {
  afterAll(() => {
    fs.rmSync(runScratchRoot(), { recursive: true, force: true });
  });

  it("creates and removes the run-private TMPDIR and cache root", async () => {
    const ctx = createRunSandbox("test-run-1");
    expect(fs.existsSync(ctx.tmpdir)).toBe(true);
    expect(fs.existsSync(ctx.cacheRoot)).toBe(true);
    expect(ctx.env.TMPDIR).toBe(ctx.tmpdir);
    // No delegated cgroup subtree in a test env → the watchdog is the bound.
    expect(ctx.diskLimitMechanism).toBe("watchdog");
    // The pgid file MUST sit inside the run's TMPDIR — an L1 allowWrite root —
    // or the commandPrefix's in-sandbox `echo "$$" >> pgids` is denied and
    // process-group reaping (1f) is inert for every sandboxed run.
    expect(ctx.pgidFile.startsWith(ctx.tmpdir + path.sep)).toBe(true);
    await ctx.cleanup();
    expect(fs.existsSync(ctx.root)).toBe(false);
  });

  it("cleanup removes the root even after failures (idempotent)", async () => {
    const ctx = createRunSandbox("test-run-2");
    await ctx.cleanup();
    await ctx.cleanup();
    expect(fs.existsSync(ctx.root)).toBe(false);
  });

  it("keeps ulimit -u and -v out of the preamble (self-DoS / Go+JVM breakage)", () => {
    const prefix = buildCommandPrefix("/tmp/pgids", null);
    expect(prefix).toMatch(/ulimit -t /);
    expect(prefix).toMatch(/ulimit -f /);
    expect(prefix).not.toMatch(/ulimit -u/);
    expect(prefix).not.toMatch(/ulimit -v/);
  });

  describe("srtConfig (spec 14 Phase 6)", () => {
    let repoDir: string;

    afterAll(() => {
      fs.rmSync(repoDir, { recursive: true, force: true });
    });

    it("builds a real srtConfig when given a cwd and sandboxEnabled", async () => {
      repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-sandbox-ctx-git-"));
      await execFileAsync("git", ["-C", repoDir, "init"]);
      await execFileAsync("git", ["-C", repoDir, "config", "user.email", "t@t.com"]);
      await execFileAsync("git", ["-C", repoDir, "config", "user.name", "T"]);
      fs.writeFileSync(path.join(repoDir, "f"), "x");
      await execFileAsync("git", ["-C", repoDir, "add", "."]);
      await execFileAsync("git", ["-C", repoDir, "commit", "-m", "init"]);

      const ctx = createRunSandbox("test-run-srt-1", {
        cwd: repoDir,
        s: testSettings({ sandboxEnabled: true }),
      });
      try {
        expect(ctx.srtConfig).toBeDefined();
        expect(ctx.srtConfig!.filesystem.allowWrite).toContain(repoDir);
        expect(ctx.srtConfig!.network.allowedDomains).toContain("registry.npmjs.org");
      } finally {
        await ctx.cleanup();
      }
    });

    it("leaves srtConfig undefined when sandboxEnabled is off, even with a cwd", () => {
      const ctx = createRunSandbox("test-run-srt-2", {
        cwd: "/does/not/matter/when/disabled",
        s: testSettings({ sandboxEnabled: false }),
      });
      expect(ctx.srtConfig).toBeUndefined();
      return ctx.cleanup();
    });

    it("leaves srtConfig undefined when no cwd is given, regardless of sandboxEnabled", async () => {
      const ctx = createRunSandbox("test-run-srt-3", { s: testSettings({ sandboxEnabled: true }) });
      expect(ctx.srtConfig).toBeUndefined();
      await ctx.cleanup();
    });
  });
});

describe("process-group reaping (spec 14 L3 1f)", () => {
  it("kills a backgrounded process (`nohup sleep 600 &`) and verifies the group is empty", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-reap-"));
    const pgidFile = path.join(dir, "pgids");
    try {
      // Mirror pi's bash spawn: detached shell (its own process group) that
      // runs the commandPrefix then backgrounds a long sleep and exits.
      const prefix = buildCommandPrefix(pgidFile, null);
      await new Promise<void>((resolve, reject) => {
        const child = spawn("/bin/bash", ["-c", `${prefix}\nnohup sleep 600 >/dev/null 2>&1 &`], {
          detached: true,
          stdio: "ignore",
        });
        child.on("exit", () => resolve());
        child.on("error", reject);
        child.unref();
      });
      const pgids = readPgids(pgidFile);
      expect(pgids.length).toBe(1);
      // The sleep survives its shell — exactly the escape being closed.
      const alive = () => {
        try {
          process.kill(-pgids[0], 0);
          return true;
        } catch {
          return false;
        }
      };
      expect(alive()).toBe(true);

      const leftover = await reapProcessGroups(pgidFile);
      expect(leftover).toEqual([]);
      expect(alive()).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores garbage and dangerous pgid values", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-reap2-"));
    const pgidFile = path.join(dir, "pgids");
    try {
      fs.writeFileSync(pgidFile, `0\n1\n-5\nnot-a-pid\n${process.pid}\n`);
      expect(readPgids(pgidFile)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cgroup plan (spec 14 L3 1e — unit level; enforcement is checklist #9)", () => {
  it("assembles memory/pids/io limits under the radulf subtree", () => {
    const plan = cgroupPlanForRun("run-x", "/sys/fs/cgroup");
    expect(plan.dir).toBe("/sys/fs/cgroup/radulf/run-run-x");
    const files = plan.writes.map(([f]) => f);
    expect(files).toContain("memory.max");
    expect(files).toContain("pids.max");
    expect(files).toContain("io.weight");
    // RLIMIT-style per-process knobs must not sneak in here either.
    expect(files.join()).not.toMatch(/nproc|rlimit/i);
  });
});

describe("disk watchdog (spec 14 L3 1e)", () => {
  it("trips once usage crosses the per-run bound", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-disk-"));
    try {
      fs.writeFileSync(path.join(dir, "big"), Buffer.alloc(256 * 1024));
      const tripped: string[] = [];
      await new Promise<void>((resolve) => {
        startDiskWatchdog({
          paths: [dir],
          maxRunBytes: 64 * 1024,
          intervalMs: 25,
          onTrip: (reason) => {
            tripped.push(reason);
            resolve();
          },
        });
      });
      expect(tripped).toHaveLength(1);
      expect(tripped[0]).toMatch(/disk watchdog/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not trip under the bound and can be stopped", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-disk2-"));
    try {
      fs.writeFileSync(path.join(dir, "small"), "tiny");
      const tripped: string[] = [];
      const watchdog = startDiskWatchdog({
        paths: [dir],
        maxRunBytes: 1024 * 1024 * 1024,
        minFreeBytes: 1, // effectively never
        intervalMs: 20,
        onTrip: (r) => tripped.push(r),
      });
      await new Promise((res) => setTimeout(res, 80));
      watchdog.stop();
      expect(tripped).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sums usage across the run's dirs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-disk3-"));
    try {
      fs.mkdirSync(path.join(dir, "a"));
      fs.writeFileSync(path.join(dir, "a", "f"), Buffer.alloc(128 * 1024));
      const bytes = await sampleUsageBytes([path.join(dir, "a"), path.join(dir, "missing")]);
      expect(bytes).toBeGreaterThanOrEqual(128 * 1024);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("apfs-quota detection (spec 14 verification checklist #9)", () => {
  // Field values captured live from a real `diskutil apfs addVolume … -quota
  // 200m` volume vs. the boot Data volume (2026-07-22). A quota reports
  // TotalSize below the shared container size; a plain volume reports them equal.
  const plist = (totalSize: number, containerSize: number) =>
    `<plist><dict>` +
    `<key>APFSContainerSize</key><integer>${containerSize}</integer>` +
    `<key>TotalSize</key><integer>${totalSize}</integer>` +
    `</dict></plist>`;

  it("stamps apfs-quota when TotalSize is below the container size", () => {
    expect(mechanismFromDiskutilPlist(plist(200003584, 994662584320))).toBe("apfs-quota");
  });

  it("stamps watchdog when a plain volume reports total === container", () => {
    expect(mechanismFromDiskutilPlist(plist(994662584320, 994662584320))).toBe("watchdog");
  });

  it("falls back to watchdog when the fields are absent or unparseable", () => {
    expect(mechanismFromDiskutilPlist("<plist><dict></dict></plist>")).toBe("watchdog");
    expect(mechanismFromDiskutilPlist("not a plist at all")).toBe("watchdog");
  });
});
