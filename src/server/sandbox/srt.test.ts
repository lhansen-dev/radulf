import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { getApplySeccompBinaryPath } from "@anthropic-ai/sandbox-runtime/dist/sandbox/generate-seccomp-filter.js";
import {
  buildFilesystemConfig,
  buildNetworkConfig,
  buildRunSandboxConfig,
  createSandboxedBashOperations,
  credentialBackstopDenylist,
  dropRootsThatWouldReopen,
  gitWorktreeDenies,
  initializeSandboxRuntimeOnce,
  parseNetworkAllowlist,
  resetSandboxRuntimeForTests,
  resolveGitCommonDir,
  sandboxPreflight,
  systemReadRoots,
  toolchainHomeReAllows,
  toolchainReadRootsFromPath,
  wrapBashCommand,
} from "./srt";

const execFileAsync = promisify(execFile);

function git(dir: string, ...args: string[]) {
  return execFileAsync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

describe("credentialBackstopDenylist", () => {
  it("expands every entry under $HOME, including .ssh and .aws", () => {
    const list = credentialBackstopDenylist();
    const home = os.homedir();
    expect(list).toContain(path.join(home, ".ssh"));
    expect(list).toContain(path.join(home, ".aws"));
    expect(list).toContain(path.join(home, ".npmrc"));
    expect(list).toContain(path.join(home, ".cargo", "credentials"));
    expect(list.every((p) => p.startsWith(home))).toBe(true);
  });
});

describe("systemReadRoots", () => {
  it("includes /usr and /etc on the current (macOS/Linux) platform", () => {
    const roots = systemReadRoots();
    expect(roots).toContain("/usr");
    expect(roots).toContain("/etc");
  });
});

describe("toolchainReadRootsFromPath", () => {
  it("includes each PATH entry and its parent directory, ignoring empty segments", () => {
    const roots = toolchainReadRootsFromPath("/usr/local/bin::/opt/homebrew/bin");
    expect(roots).toEqual(
      expect.arrayContaining(["/usr/local/bin", "/usr/local", "/opt/homebrew/bin", "/opt/homebrew"]),
    );
    expect(roots).not.toContain("");
  });
});

describe("toolchainHomeReAllows", () => {
  it("never re-allows .pyenv or .cargo/credentials (spec explicitly forbids both)", () => {
    const reallows = toolchainHomeReAllows();
    expect(reallows.some((p) => p.includes(".pyenv"))).toBe(false);
    expect(reallows.some((p) => p.includes(".cargo/credentials") || p.includes(".cargo\\credentials"))).toBe(
      false,
    );
    expect(reallows.some((p) => p.endsWith(path.join(".cargo", "registry")))).toBe(true);
  });
});

describe("parseNetworkAllowlist / buildNetworkConfig", () => {
  it("always includes registry.npmjs.org, then extra domains trimmed, deduped, blank lines dropped", () => {
    expect(parseNetworkAllowlist("")).toEqual(["registry.npmjs.org"]);
    expect(parseNetworkAllowlist("pypi.org\n  \nregistry.npmjs.org\ngithub.com\n")).toEqual([
      "registry.npmjs.org",
      "pypi.org",
      "github.com",
    ]);
  });

  it("buildNetworkConfig sets an empty deniedDomains and the parsed allowlist", () => {
    const cfg = buildNetworkConfig("pypi.org");
    expect(cfg.allowedDomains).toEqual(["registry.npmjs.org", "pypi.org"]);
    expect(cfg.deniedDomains).toEqual([]);
  });
});

describe("buildRunSandboxConfig — Go/TLS trustd carve-out (opt-in)", () => {
  it("sets enableWeakerNetworkIsolation only when opted in (srt's strict default otherwise)", () => {
    const base = {
      worktree: "/tmp/wt",
      gitCommonDir: "/tmp/wt/.git",
      tmpdir: "/tmp/wt/.tmp",
      cacheRoot: "/tmp/wt/.cache",
      networkAllowlistText: "",
    };
    expect(buildRunSandboxConfig(base).enableWeakerNetworkIsolation).toBeUndefined();
    expect(
      buildRunSandboxConfig({ ...base, weakerIsolationForGoTls: false }).enableWeakerNetworkIsolation,
    ).toBeUndefined();
    expect(
      buildRunSandboxConfig({ ...base, weakerIsolationForGoTls: true }).enableWeakerNetworkIsolation,
    ).toBe(true);
  });
});

describe("buildFilesystemConfig", () => {
  // No such repo on disk, so there are no per-worktree configs to enumerate.
  const cfg = buildFilesystemConfig({
    worktree: "/data/worktrees/run-1",
    gitCommonDir: "/data/repo/.git",
    tmpdir: "/data/runtmp/run-1/tmp",
    cacheRoot: "/data/runtmp/run-1/cache",
  });

  it("denies $HOME wholesale and re-allows writes only to this run's own paths", () => {
    expect(cfg.denyRead).toContain(os.homedir());
    expect(cfg.allowRead).toContain("/data/worktrees/run-1");
    expect(cfg.allowWrite).toEqual([
      "/data/worktrees/run-1",
      "/data/runtmp/run-1/tmp",
      "/data/runtmp/run-1/cache",
      "/data/repo/.git",
    ]);
  });

  it("carves the hook/config and ref vectors out of the git-write allow", () => {
    // The `*` patterns are macOS-only. See gitWorktreeDenies.
    expect(cfg.denyWrite).toEqual([
      "/data/repo/.git/hooks",
      "/data/repo/.git/config",
      "/data/repo/.git/refs",
      "/data/repo/.git/packed-refs",
      "/data/repo/.git/HEAD",
      ...(process.platform === "darwin"
        ? ["/data/repo/.git/worktrees/*/config", "/data/repo/.git/worktrees/*/HEAD"]
        : []),
    ]);
  });

  it("keeps the credential backstop, including gh's store, even though $HOME is already denied", () => {
    // Spec 15 gave the HOST process the operator's GitHub credential to push
    // and open PRs. The agent must gain nothing from that: this fails if a
    // broken host-side push is ever "fixed" by loosening the sandbox instead.
    expect(cfg.denyRead).toContain(path.join(os.homedir(), ".ssh"));
    expect(cfg.denyRead).toContain(path.join(os.homedir(), ".config/gh"));
  });

  it("regression: never lets a PATH-derived root (e.g. /bin's parent, '/') re-open $HOME", () => {
    // Every Unix PATH realistically contains /bin or /sbin — their dirname is
    // "/", which under srt's recursive subpath matching silently re-opens
    // everything (see dropRootsThatWouldReopen). Uses the real
    // process.env.PATH deliberately, so this keeps failing on whatever machine
    // runs it if the guard ever regresses.
    expect(cfg.allowRead).not.toContain("/");
    const home = os.homedir();
    for (const root of cfg.allowRead ?? []) {
      expect(home === root || home.startsWith(root.endsWith("/") ? root : root + "/")).toBe(false);
    }
  });
});

describe("dropRootsThatWouldReopen", () => {
  it.each([
    ["'/' unconditionally", ["/", "/tmp/x"], ["/tmp/x"]],
    ["a candidate that IS a protected root", ["/Users/x", "/tmp/y"], ["/tmp/y"]],
    ["a proper ANCESTOR of a protected root", ["/Users", "/tmp/y"], ["/tmp/y"]],
    // The intended narrow re-allow case.
    ["nothing for a DESCENDANT of a protected root", ["/Users/x/.nvm"], ["/Users/x/.nvm"]],
    ["nothing for an unrelated root", ["/usr/local"], ["/usr/local"]],
    // "/Users/x-evil" is NOT inside "/Users/x" — a naive startsWith without
    // the trailing separator would wrongly treat it as related.
    ["nothing for a sibling sharing a string prefix", ["/Users/x-evil"], ["/Users/x-evil"]],
  ])("drops %s", (_label, candidates, expected) => {
    expect(dropRootsThatWouldReopen(candidates, ["/Users/x"])).toEqual(expected);
  });
});

describe("resolveGitCommonDir", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-srt-git-"));
    await git(tmpDir, "init");
    await git(tmpDir, "config", "user.email", "test@test.com");
    await git(tmpDir, "config", "user.name", "Test");
    fs.writeFileSync(path.join(tmpDir, "f.txt"), "x");
    await git(tmpDir, "add", ".");
    await git(tmpDir, "commit", "-m", "init");
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves the main repo's .git dir for an ordinary (non-worktree) checkout", () => {
    expect(resolveGitCommonDir(tmpDir)).toBe(path.join(tmpDir, ".git"));
  });

  it("resolves the SHARED .git dir for a linked worktree, not the worktree's own pointer file", async () => {
    const worktreePath = path.join(tmpDir, "..", "radulf-srt-git-wt");
    await git(tmpDir, "worktree", "add", worktreePath, "-b", "feature");
    try {
      // realpath: on macOS os.tmpdir() is a /var symlink into /private/var,
      // and `git rev-parse` resolves through it — compare canonical paths.
      expect(resolveGitCommonDir(worktreePath)).toBe(fs.realpathSync(path.join(tmpDir, ".git")));
    } finally {
      await git(tmpDir, "worktree", "remove", "--force", worktreePath).catch(() => {});
    }
  });

  it("throws for a directory that is not a git repo at all (fail loud, no silent fallback)", () => {
    const notGit = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-srt-notgit-"));
    try {
      expect(() => resolveGitCommonDir(notGit)).toThrow();
    } finally {
      fs.rmSync(notGit, { recursive: true, force: true });
    }
  });
});

describe("gitWorktreeDenies", () => {
  let repoDir: string;
  let gitCommonDir: string;
  let worktreePath: string;

  beforeAll(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-srt-wtdeny-"));
    await git(repoDir, "init");
    await git(repoDir, "config", "user.email", "t@t.com");
    await git(repoDir, "config", "user.name", "T");
    fs.writeFileSync(path.join(repoDir, "f"), "x");
    await git(repoDir, "add", ".");
    await git(repoDir, "commit", "-m", "init");
    gitCommonDir = resolveGitCommonDir(repoDir);
    worktreePath = path.join(repoDir, "..", "radulf-srt-wtdeny-wt");
    await git(repoDir, "worktree", "add", worktreePath, "-b", "wtdeny");
  });

  afterAll(async () => {
    await git(repoDir, "worktree", "remove", "--force", worktreePath).catch(() => {});
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(worktreePath, { recursive: true, force: true });
  });

  it("names the config and HEAD of every registered linked worktree as concrete paths", () => {
    // Concrete, not a `*` pattern: bwrap has no pattern support, so the
    // pattern form protected nothing on Linux.
    const denies = gitWorktreeDenies(gitCommonDir);
    const wtDir = path.join(gitCommonDir, "worktrees", path.basename(worktreePath));
    expect(denies).toContain(path.join(wtDir, "config"));
    expect(denies).toContain(path.join(wtDir, "HEAD"));
    expect(denies.every((p) => path.isAbsolute(p) && !p.includes("*"))).toBe(true);
  });

  it("returns nothing for a repo with no linked worktrees, rather than throwing", () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-srt-nowt-"));
    try {
      expect(gitWorktreeDenies(path.join(bare, ".git"))).toEqual([]);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("sandboxPreflight / initializeSandboxRuntimeOnce (real srt, no mocks)", () => {
  it("reports this platform as supported", () => {
    // This suite only runs in this repo's dev/CI environment (macOS or
    // Linux); srt itself gates unsupported platforms structurally.
    expect(SandboxManager.isSupportedPlatform()).toBe(true);
    const result = sandboxPreflight();
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("is idempotent and memoized across calls", async () => {
    resetSandboxRuntimeForTests();
    const first = await initializeSandboxRuntimeOnce();
    const second = await initializeSandboxRuntimeOnce();
    expect(first.ok).toBe(true);
    expect(second).toBe(first); // same cached promise resolution, not re-run
  });

  it("fails preflight when dependencies exist but a wrapped command cannot start", async () => {
    resetSandboxRuntimeForTests();
    const wrap = vi.spyOn(SandboxManager, "wrapWithSandbox").mockResolvedValue(
      "echo 'apply-seccomp: No such file or directory' >&2; exit 127",
    );
    try {
      const result = await initializeSandboxRuntimeOnce();
      expect(result.ok).toBe(false);
      expect(result.errors.join("\n")).toContain("sandbox startup failed");
      expect(result.errors.join("\n")).toContain("apply-seccomp: No such file or directory");
      expect(await initializeSandboxRuntimeOnce()).toBe(result);
      expect(wrap).toHaveBeenCalledTimes(1);
    } finally {
      wrap.mockRestore();
      resetSandboxRuntimeForTests();
    }
  });
});

describe("wrapBashCommand / createSandboxedBashOperations (real sandboxed process)", () => {
  let worktree: string;
  let outside: string;

  beforeAll(async () => {
    await initializeSandboxRuntimeOnce();
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-srt-wt-"));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-srt-outside-"));
  });

  afterAll(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  function config() {
    return buildRunSandboxConfig({
      worktree,
      gitCommonDir: worktree,
      tmpdir: worktree,
      cacheRoot: worktree,
      networkAllowlistText: "",
    });
  }

  it.skipIf(process.platform !== "linux")("runs with a minimal PATH without exposing the helper's parent directory", async () => {
    // make normally puts node_modules/.bin on PATH, incidentally reopening
    // node_modules. A production server need not have that PATH entry.
    vi.stubEnv("PATH", "/usr/bin:/bin");
    try {
      const cfg = config();
      const helper = getApplySeccompBinaryPath()!;
      expect(cfg.filesystem.allowRead).toContain(helper);
      expect(cfg.filesystem.allowRead).not.toContain(path.dirname(helper));
      const ops = createSandboxedBashOperations(cfg);
      const chunks: Buffer[] = [];
      const result = await ops.exec("printf sandbox-started", worktree, {
        onData: (data) => chunks.push(data),
      });
      expect(Buffer.concat(chunks).toString()).toBe("sandbox-started");
      expect(result.exitCode).toBe(0);

      // Under a home-directory install, removing just the exemption reproduces
      // the original failure before the requested command can execute.
      if (helper.startsWith(os.homedir() + path.sep)) {
        cfg.filesystem.allowRead = cfg.filesystem.allowRead!.filter((root) => root !== helper);
        const brokenChunks: Buffer[] = [];
        const broken = await createSandboxedBashOperations(cfg).exec("printf unreachable", worktree, {
          onData: (data) => brokenChunks.push(data),
        });
        expect(broken.exitCode).not.toBe(0);
        expect(Buffer.concat(brokenChunks).toString()).toContain("apply-seccomp");
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("wrapBashCommand allows a write inside the worktree and denies one outside it", async () => {
    const ok = await wrapBashCommand(`echo hi > ${worktree}/ok.txt`, config());
    await execFileAsync("/bin/sh", ["-c", ok]);
    expect(fs.existsSync(path.join(worktree, "ok.txt"))).toBe(true);

    const denied = await wrapBashCommand(`echo hi > ${outside}/bad.txt`, config());
    await expect(execFileAsync("/bin/sh", ["-c", denied])).rejects.toThrow();
    expect(fs.existsSync(path.join(outside, "bad.txt"))).toBe(false);
  });

  it("serializes, rather than rejects, concurrent calls whose configs differ only in filesystem paths", async () => {
    // Phase 10 made one-loop-per-repo concurrency the normal steady state.
    // Two DIFFERENT repos' concurrent runs always get distinct filesystem
    // config (own worktree/tmpdir/cacheRoot) but the SAME network policy
    // (derived from the same global settings) — this is the exact shape
    // 19.1 fixes. Building two separate config objects here (not one shared
    // reference) matters: a whole-config comparison bug like 19.1's would
    // treat these as "different" purely because of the filesystem paths and
    // wrongly throw, even though a reference-equal object would short-circuit
    // any comparison, buggy or not, and never catch that class of bug.
    const worktreeA = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-srt-wt-a-"));
    const worktreeB = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-srt-wt-b-"));
    try {
      const cfgA = buildRunSandboxConfig({
        worktree: worktreeA,
        gitCommonDir: worktreeA,
        tmpdir: worktreeA,
        cacheRoot: worktreeA,
        networkAllowlistText: "",
      });
      const cfgB = buildRunSandboxConfig({
        worktree: worktreeB,
        gitCommonDir: worktreeB,
        tmpdir: worktreeB,
        cacheRoot: worktreeB,
        networkAllowlistText: "",
      });
      // Sanity check that this test is actually exercising two distinct
      // config objects (different filesystem slice), not accidentally back
      // to the old shared-reference shape.
      expect(cfgA).not.toBe(cfgB);
      expect(cfgA.filesystem).not.toEqual(cfgB.filesystem);
      expect(cfgA.network).toEqual(cfgB.network);

      const events: string[] = [];
      const origUpdateConfig = SandboxManager.updateConfig.bind(SandboxManager);
      const origWrap = SandboxManager.wrapWithSandbox.bind(SandboxManager);
      const updateConfigSpy = vi.spyOn(SandboxManager, "updateConfig").mockImplementation((cfg) => {
        events.push("updateConfig");
        return origUpdateConfig(cfg);
      });
      const wrapSpy = vi
        .spyOn(SandboxManager, "wrapWithSandbox")
        .mockImplementation(async (...args: Parameters<typeof SandboxManager.wrapWithSandbox>) => {
          const result = await origWrap(...args);
          events.push("wrapWithSandbox-done");
          return result;
        });
      try {
        const [first, second] = await Promise.all([
          wrapBashCommand(`echo hi > ${worktreeA}/concurrent-first.txt`, cfgA),
          wrapBashCommand(`echo hi > ${worktreeB}/concurrent-second.txt`, cfgB),
        ]);
        expect(first).toEqual(expect.any(String));
        expect(second).toEqual(expect.any(String));
        // Each call's updateConfig is immediately followed by ITS OWN
        // wrapWithSandbox completion before the other call's updateConfig
        // ever runs — proves the two calls' wrap-and-updateConfig steps never
        // interleave, even though neither call was rejected.
        expect(events).toEqual([
          "updateConfig",
          "wrapWithSandbox-done",
          "updateConfig",
          "wrapWithSandbox-done",
        ]);
      } finally {
        updateConfigSpy.mockRestore();
        wrapSpy.mockRestore();
      }
    } finally {
      fs.rmSync(worktreeA, { recursive: true, force: true });
      fs.rmSync(worktreeB, { recursive: true, force: true });
    }
  });

  it("hard-throws when two concurrent calls carry different network configs", async () => {
    const cfgA = config();
    const cfgB = {
      ...cfgA,
      network: { ...cfgA.network, allowedDomains: [...cfgA.network.allowedDomains, "example.com"] },
    };
    // Fired without awaiting: wrapBashCommand runs synchronously up to its
    // first `await`, so cfgA's call has already claimed the queue slot by
    // the time cfgB's call's synchronous guard check runs — no mocking
    // needed to observe the race.
    const first = wrapBashCommand(`echo hi > ${worktree}/concurrent-diff-a.txt`, cfgA);
    await expect(
      wrapBashCommand(`echo hi > ${worktree}/concurrent-diff-b.txt`, cfgB),
    ).rejects.toThrow(/DIFFERENT network policy/);
    await expect(first).resolves.toEqual(expect.any(String));
  });

  it("createSandboxedBashOperations.exec runs the command sandboxed via pi's own local exec", async () => {
    const ops = createSandboxedBashOperations(config());
    const chunks: Buffer[] = [];
    const result = await ops.exec(`echo from-sandbox`, worktree, {
      onData: (d) => chunks.push(d),
    });
    expect(result.exitCode).toBe(0);
    expect(Buffer.concat(chunks).toString()).toContain("from-sandbox");
  });
});

/**
 * Direct mechanical verification of individual rows from spec 14's
 * §Acceptance-tests table, using the real `buildRunSandboxConfig` a
 * production run would build and real sandboxed processes (no LLM, no
 * mocks). Not a substitute for the full table run against a live agent
 * transcript (PLAN_SPEC_14.md Phase 6 still flags that as open — it needs a
 * real run and, for several rows, a Linux/Docker host this environment
 * doesn't have) — but every row exercised here is a genuine, unmocked
 * check of the mechanism the table names.
 */
describe("acceptance-test table — individual rows verified directly (spec 14 §Acceptance tests)", () => {
  /** Seed contents of the per-worktree git config the deny must preserve. */
  const WT_CONFIG = "# pre-existing\n";
  let worktree: string;
  let repoDir: string;
  let gitCommonDir: string;

  async function run(cmd: string) {
    const wrapped = await wrapBashCommand(
      cmd,
      buildRunSandboxConfig({
        worktree,
        gitCommonDir,
        tmpdir: worktree,
        cacheRoot: worktree,
        networkAllowlistText: "",
      }),
    );
    return execFileAsync("/bin/sh", ["-c", wrapped]);
  }

  beforeAll(async () => {
    await initializeSandboxRuntimeOnce();
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-accept-repo-"));
    await git(repoDir, "init");
    await git(repoDir, "config", "user.email", "t@t.com");
    await git(repoDir, "config", "user.name", "T");
    fs.writeFileSync(path.join(repoDir, "f"), "x");
    await git(repoDir, "add", ".");
    await git(repoDir, "commit", "-m", "init");
    worktree = path.join(repoDir, "..", "radulf-accept-wt");
    await git(repoDir, "worktree", "add", worktree, "-b", "accept-feature");
    // A branch nothing has checked out: the one shape of `git checkout` that
    // git itself would not refuse inside a linked worktree.
    await git(repoDir, "branch", "accept-other");
    gitCommonDir = resolveGitCommonDir(worktree);
    // Seed the per-worktree config BEFORE the first sandboxed run. For a deny
    // path that doesn't exist yet, srt has bwrap create a read-only mount
    // point for it on the host and only unlinks it in a process-exit handler —
    // so once any run() has happened, this file is no longer writable from the
    // test process either.
    fs.writeFileSync(path.join(gitCommonDir, "worktrees", path.basename(worktree), "config"), WT_CONFIG);
  });

  afterAll(async () => {
    await git(repoDir, "worktree", "remove", "--force", worktree).catch(() => {});
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  it("`cat <DATA_DIR>/…` — L1 read deny of Radulf's own data dir", async () => {
    const { DATA_DIR } = await import("@/db");
    const canary = path.join(DATA_DIR, `srt-accept-canary-${process.pid}.txt`);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(canary, "radulf internal state — must not be agent-readable");
    try {
      await expect(run(`cat ${canary}`)).rejects.toThrow();
    } finally {
      fs.rmSync(canary, { force: true });
    }
  });

  it("`cat` a real file directly under $HOME — L1 $HOME read deny (the mechanism `credentialBackstopDenylist` defends in depth)", async () => {
    // Deliberately does NOT touch ~/.npmrc / ~/.git-credentials / ~/.aws —
    // real developer config, never written to by a test. A macOS Seatbelt
    // deny on a path that doesn't exist surfaces as an ordinary ENOENT (the
    // VFS resolves "no such file" before the permission check ever
    // matters — harmless, since there's no content to leak either way), so
    // this test proves the mechanism with a canary file it fully owns
    // instead of asserting on that distinction against real dotfiles.
    const canary = path.join(os.homedir(), `.radulf-sandbox-test-canary-${process.pid}`);
    fs.writeFileSync(canary, "sentinel — must not be sandbox-readable");
    try {
      await expect(run(`cat ${canary}`)).rejects.toThrow();
    } finally {
      fs.rmSync(canary, { force: true });
    }
  });

  it("`curl` to a non-allowlisted domain — L1 egress proxy", async () => {
    const result = await run(
      `curl -sS -m 5 -o /dev/null -w '%{http_code}' https://this-domain-is-not-allowlisted.example.com`,
    ).catch((e) => e);
    // Either the shell command itself fails, or curl reports a non-2xx/000
    // via the proxy's own refusal — either way the request never reaches
    // the real internet as an allowed request would.
    if (result instanceof Error) {
      expect((result as { stderr?: string }).stderr ?? "").not.toBe("");
    } else {
      expect((result as { stdout: string }).stdout).not.toMatch(/^2\d\d$/);
    }
  });

  it("`curl` to the default-allowed registry.npmjs.org succeeds — regression for the updateConfig bug found by the live positive control", async () => {
    // A real card run (spec 14 Phase 6 positive control) hit `npm error 403
    // ... blocked-by-allowlist` against registry.npmjs.org despite it being
    // in the run's allowedDomains — srt's egress proxy filters every
    // request against the SESSION-level config set at initialize()/
    // updateConfig() time, never against wrapWithSandbox's per-call
    // customConfig.network (confirmed by reading srt's own
    // filterNetworkRequest, which closes over the session-level `config`
    // variable, not an argument). `wrapBashCommand` now calls
    // `SandboxManager.updateConfig()` before wrapping — this proves the
    // default allowlist actually reaches the real npm registry end to end.
    const result = await run(
      `curl -sS -m 10 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/is-odd`,
    );
    expect(result.stdout.trim()).toBe("200");
  });

  it("`nc` raw-socket connect to a non-allowlisted host — L1 platform layer, not just the HTTP proxy", async () => {
    // Bypasses HTTP_PROXY entirely (nc doesn't consult it) — this is
    // checklist #7's "a tool with its own resolver" case: a passing curl
    // through the proxy proves nothing about raw sockets.
    await expect(run(`nc -G 3 -w 3 93.184.216.34 80 </dev/null`)).rejects.toThrow();
  });

  it("write `<repo>/.git/hooks/pre-commit` — L1 write deny", async () => {
    await expect(run(`echo evil > ${gitCommonDir}/hooks/pre-commit`)).rejects.toThrow();
    expect(fs.existsSync(path.join(gitCommonDir, "hooks", "pre-commit"))).toBe(false);
  });

  it("write `<repo>/.git/config` — L1 write deny", async () => {
    const before = fs.readFileSync(path.join(gitCommonDir, "config"), "utf8");
    await expect(run(`echo "[evil]" >> ${gitCommonDir}/config`)).rejects.toThrow();
    expect(fs.readFileSync(path.join(gitCommonDir, "config"), "utf8")).toBe(before);
  });

  it("write `<repo>/.git/worktrees/<name>/config` — L1 write deny (per-worktree carve-out)", async () => {
    // Seeded in beforeAll. Denied on Linux only because the carve-out names
    // this config as a concrete path: a `*` pattern is inert under bwrap.
    const wtConfig = path.join(gitCommonDir, "worktrees", path.basename(worktree), "config");
    await expect(run(`echo evil >> ${wtConfig}`)).rejects.toThrow();
    expect(fs.readFileSync(wtConfig, "utf8")).toBe(WT_CONFIG);
  });

  it("`git checkout` onto another branch inside the worktree — L1 write deny of the worktree's HEAD", async () => {
    await expect(run(`git -C ${worktree} checkout -q accept-other`)).rejects.toThrow();
    expect((await git(worktree, "symbolic-ref", "--short", "HEAD")).stdout.trim()).toBe("accept-feature");
    // Git rolls its lock back on the failed rename; a stale one would block the host's next commit.
    expect(fs.existsSync(path.join(gitCommonDir, "worktrees", path.basename(worktree), "HEAD.lock"))).toBe(false);
  });

  it("`git tag` inside the worktree — L1 write deny of the shared refs/", async () => {
    await expect(run(`git -C ${worktree} tag accept-evil`)).rejects.toThrow();
    expect(fs.existsSync(path.join(gitCommonDir, "refs", "tags", "accept-evil"))).toBe(false);
  });

  it("connect to /var/run/docker.sock — L1 socket policy (Unix sockets denied by default)", async () => {
    if (!fs.existsSync("/var/run/docker.sock")) return; // not every dev host has Docker installed
    await expect(run(`nc -G 3 -w 3 -U /var/run/docker.sock </dev/null`)).rejects.toThrow();
  });
});
