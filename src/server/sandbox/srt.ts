import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

import {
  SandboxManager,
  type SandboxRuntimeConfig,
  type FilesystemConfig,
  type NetworkConfig,
} from "@anthropic-ai/sandbox-runtime";
import { getApplySeccompBinaryPath } from "@anthropic-ai/sandbox-runtime/dist/sandbox/generate-seccomp-filter.js";
import { createLocalBashOperations, type BashOperations } from "@earendil-works/pi-coding-agent";

import { DATA_DIR, WORKTREES_DIR } from "@/db";

/**
 * Layer 1 — OS sandbox on agent bash (spec 14 Phase 6), via
 * `@anthropic-ai/sandbox-runtime` ("srt"): Seatbelt on macOS, bubblewrap +
 * seccomp on Linux.
 *
 * Spike findings (PLAN_SPEC_14.md Phase 5, verified live on macOS):
 * `SandboxManager` is a process-wide singleton initialized once;
 * `wrapWithSandbox(command, binShell?, customConfig?)` takes a per-call
 * `Partial<SandboxRuntimeConfig>` that overrides the session baseline
 * field-by-field, so per-run policy (a different worktree/TMPDIR/cache root
 * per run) needs no re-`initialize()` and no config file.
 */

const HOME = os.homedir();
const execFileAsync = promisify(execFile);

/** Use srt's own resolver so the executable allowed here is the one it invokes. */
function sandboxHelperReadRoots(): string[] {
  if (process.platform !== "linux") return [];
  const helper = getApplySeccompBinaryPath();
  if (!helper) throw new Error("sandbox apply-seccomp helper is missing; reinstall dependencies");
  // Only this executable, never the surrounding application or node_modules.
  return [helper];
}

/**
 * Backstop credential denylist (spec §L1). `$HOME` is already denied in
 * full, so every one of these is already unreachable — this list exists so
 * that if a *future* narrow re-allow under `$HOME` is widened by mistake,
 * the obvious high-value targets are still explicitly closed. Never remove
 * an entry to "simplify" — that is exactly the regression this list guards
 * against.
 */
export function credentialBackstopDenylist(): string[] {
  return [
    ".ssh",
    ".aws",
    ".config/gh",
    ".netrc",
    ".npmrc",
    ".git-credentials",
    ".docker/config.json",
    ".kube",
    ".config/gcloud",
    ".cargo/credentials",
    ".gnupg",
    "Library/Keychains",
    "Library/Application Support/Google/Chrome",
    "Library/Application Support/Firefox",
    "Library/Cookies",
  ].map((p) => path.join(HOME, p));
}

/** System + toolchain install roots (spec §L1 read-allow table), per platform. */
export function systemReadRoots(): string[] {
  if (process.platform === "darwin") {
    return ["/usr", "/bin", "/sbin", "/opt", "/etc", "/Library/Developer", "/nix", "/System"];
  }
  return ["/usr", "/bin", "/sbin", "/opt", "/etc", "/lib", "/lib64", "/nix"];
}

/**
 * True when `candidate` is `target` itself or a proper ancestor directory of
 * it. srt's read-allow is a *recursive* subpath match, so an `allowRead`
 * entry that is an ancestor of a supposedly-denied root re-opens that whole
 * root — this is the check that stops that from happening by accident.
 */
function isAncestorOrSelf(candidate: string, target: string): boolean {
  if (candidate === target) return true;
  const prefix = candidate.endsWith(path.sep) ? candidate : candidate + path.sep;
  return target.startsWith(prefix);
}

/**
 * Drop any candidate read-allow root that would, by containing one of
 * `protectedRoots` (or being `/` itself), silently re-open it — e.g. a PATH
 * entry of `/bin` naively contributing `/` (its `dirname`) as an "allow"
 * would recursively re-open the entire filesystem, defeating `$HOME`'s
 * deny outright. Narrow re-allows genuinely *inside* a protected root
 * (`~/.nvm` inside `$HOME`) are unaffected — this only rejects candidates
 * that are the protected root or broader.
 */
export function dropRootsThatWouldReopen(candidates: string[], protectedRoots: string[]): string[] {
  return candidates.filter(
    (c) => c !== "/" && !protectedRoots.some((protectedRoot) => isAncestorOrSelf(c, protectedRoot)),
  );
}

/**
 * Best-effort toolchain read-allow derived from `PATH`: each entry and its
 * parent (so a `.../node/bin` PATH entry also opens `.../node`'s lib/include,
 * not just the bin dir). Deduplicated; empty/missing entries dropped. Does
 * **not** itself filter out dangerous entries (e.g. `/bin`'s parent is `/`)
 * — callers must run the result through `dropRootsThatWouldReopen`.
 */
export function toolchainReadRootsFromPath(pathEnv = process.env.PATH ?? ""): string[] {
  const roots = new Set<string>();
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    roots.add(dir);
    roots.add(path.dirname(dir));
  }
  return [...roots];
}

/**
 * Narrow toolchain-state re-allows under `$HOME` (spec §L1 read-deny table).
 * Deliberately excludes `~/.cargo/credentials`, `~/.pyenv`, and
 * `~/Library/Caches/<toolchain>` — the spec calls those out by name as
 * re-allows that must NOT happen; a card that needs one is a named,
 * rationale-bearing exception to add here, not a default.
 */
export function toolchainHomeReAllows(): string[] {
  return [
    path.join(HOME, ".nvm"),
    path.join(HOME, ".rustup", "toolchains"),
    path.join(HOME, ".cargo", "registry"),
  ];
}

/**
 * Resolve the shared `.git` dir for a worktree (`git rev-parse
 * --git-common-dir`) — the parent repo's real git metadata, which a linked
 * worktree's own `.git` file only points at. The agent's git commands need
 * write access here (objects, the worktree's own index) except for the
 * hook/config and ref vectors carved out below.
 */
export function resolveGitCommonDir(worktree: string): string {
  const out = execFileSync("git", ["-C", worktree, "rev-parse", "--git-common-dir"], {
    encoding: "utf8",
  }).trim();
  return path.isAbsolute(out) ? out : path.resolve(worktree, out);
}

/**
 * Per-run filesystem policy (spec §L1 filesystem table). Read uses
 * "deny-then-allow-back": `$HOME` and Radulf's own data/worktrees roots are
 * denied wholesale, then this run's own worktree is individually re-opened
 * — verified live (PLAN_SPEC_14.md Phase 5) that a narrow `allowRead`
 * re-opens a path inside a broader `denyRead`. Write is allow-only: the
 * worktree, run-private TMPDIR/cache, and the parent repo's shared `.git`
 * except the hook/config vectors.
 */
/** The per-worktree files agent git must not write: `config` is the
 * `core.hooksPath` code-execution vector, `HEAD` is the checkout pointer. */
const WORKTREE_DENY_FILES = ["config", "HEAD"];

/**
 * Concrete `<gitCommonDir>/worktrees/<name>/{config,HEAD}` paths for every
 * linked worktree registered right now.
 *
 * srt glob-expands only its OWN mandatory deny list (via ripgrep `--iglob`).
 * A caller-supplied `denyWrite` entry is taken as a literal path: Seatbelt
 * still matches `*` as a pattern, but bwrap has no pattern support and would
 * mount over a path whose component is literally `*`, protecting nothing. So
 * the pattern form alone left these write vectors open on Linux:
 * `core.hooksPath` in a per-worktree config is arbitrary code execution on
 * the next git command, and a rewritten per-worktree `HEAD` is
 * `git checkout` onto another branch. Enumerating gives both platforms a
 * real deny.
 */
export function gitWorktreeDenies(gitCommonDir: string): string[] {
  const worktreesDir = path.join(gitCommonDir, "worktrees");
  let entries;
  try {
    entries = fs.readdirSync(worktreesDir, { withFileTypes: true });
  } catch {
    return []; // no linked worktrees registered — nothing to carve out
  }
  return entries
    .filter((e) => e.isDirectory())
    .flatMap((e) => WORKTREE_DENY_FILES.map((name) => path.join(worktreesDir, e.name, name)));
}

export function buildFilesystemConfig(opts: {
  worktree: string;
  gitCommonDir: string;
  tmpdir: string;
  cacheRoot: string;
}): FilesystemConfig {
  const denyRead = [HOME, DATA_DIR, WORKTREES_DIR, ...credentialBackstopDenylist()];
  const rawAllowRead = [
    opts.worktree,
    opts.tmpdir,
    opts.cacheRoot,
    opts.gitCommonDir,
    ...systemReadRoots(),
    ...toolchainReadRootsFromPath(),
    ...toolchainHomeReAllows(),
    ...sandboxHelperReadRoots(),
  ];
  return {
    denyRead,
    // PATH-derived roots are untrusted input to this filter — a shallow PATH
    // entry (`/bin`, whose dirname is `/`) must never silently re-open the
    // deny list. `HOME`/`DATA_DIR`/`WORKTREES_DIR` themselves are checked
    // (not just their listed backstop children) because an allow entry
    // doesn't need to name a deny target exactly to reopen it — containing
    // it is enough, per srt's recursive subpath matching.
    allowRead: dropRootsThatWouldReopen(rawAllowRead, [HOME, DATA_DIR, WORKTREES_DIR]),
    allowWrite: [opts.worktree, opts.tmpdir, opts.cacheRoot, opts.gitCommonDir],
    denyWrite: [
      path.join(opts.gitCommonDir, "hooks"),
      path.join(opts.gitCommonDir, "config"),
      // Every ref and checkout pointer. The orchestrator makes each commit
      // from the host, so agent git has no legitimate ref write: this stops
      // `git checkout <base>` inside the worktree, `git commit`,
      // `git branch -f`, `git reset` and `git update-ref` at the kernel, with
      // the orchestrator's run-branch guard as the backstop for unsandboxed
      // runs. `packed-refs` need not exist yet; srt then binds a read-only
      // stub in its place for the command's duration.
      path.join(opts.gitCommonDir, "refs"),
      path.join(opts.gitCommonDir, "packed-refs"),
      path.join(opts.gitCommonDir, "HEAD"),
      ...gitWorktreeDenies(opts.gitCommonDir),
      // Kept on macOS only: Seatbelt honours the pattern, which also covers a
      // worktree registered after this config was built — something the
      // snapshot above cannot. On Linux the same entry is inert at best, so
      // there it would only add a bogus literal-`*` mount.
      ...(process.platform === "darwin"
        ? WORKTREE_DENY_FILES.map((name) => path.join(opts.gitCommonDir, "worktrees", "*", name))
        : []),
    ],
  };
}

/** Registries are always reachable; `sandboxNetworkAllowlist` (one domain
 * per line) extends the floor. Empty setting → registries only. */
const DEFAULT_ALLOWED_DOMAINS = ["registry.npmjs.org"];

export function parseNetworkAllowlist(text: string): string[] {
  const extra = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return [...new Set([...DEFAULT_ALLOWED_DOMAINS, ...extra])];
}

/**
 * Default-deny egress with a domain allowlist (spec §L1 network table).
 * Unix domain sockets (including `/var/run/docker.sock`) are denied by NOT
 * setting `allowUnixSockets`/`allowAllUnixSockets` here — srt's own default
 * is deny-all for those; adding either key back is a security regression
 * that requires a rationale in specs/14-sandboxing.md, not a quiet edit.
 */
export function buildNetworkConfig(allowlistText: string): NetworkConfig {
  return { allowedDomains: parseNetworkAllowlist(allowlistText), deniedDomains: [] };
}

export function buildRunSandboxConfig(opts: {
  worktree: string;
  gitCommonDir: string;
  tmpdir: string;
  cacheRoot: string;
  networkAllowlistText: string;
  /** Spec 14 opt-in (default off), macOS only: allow the trustd mach service so
   * Go-family tools (go, gh, gcloud, terraform, kubectl) can verify TLS certs —
   * their verifier calls SecTrustEvaluate, which Seatbelt blocks otherwise, so
   * every Go HTTPS fetch fails under the sandbox even for an allowlisted domain.
   * srt's own `enableWeakerNetworkIsolation`. Residual: trustd runs outside the
   * sandbox and its OCSP/CRL requests bypass the egress proxy — a low-bandwidth
   * exfil channel. See settings `sandboxWeakerIsolationForGoTls`. */
  weakerIsolationForGoTls?: boolean;
}): SandboxRuntimeConfig {
  return {
    filesystem: buildFilesystemConfig(opts),
    network: buildNetworkConfig(opts.networkAllowlistText),
    // Only set when opted in — absent is srt's strict default (no trustd).
    ...(opts.weakerIsolationForGoTls ? { enableWeakerNetworkIsolation: true } : {}),
  };
}

export type SandboxPreflightResult = { ok: boolean; errors: string[]; warnings: string[] };

/** `sysctl kernel.apparmor_restrict_unprivileged_userns` — Ubuntu 24.04+'s
 * AppArmor default blocks bubblewrap's unprivileged user namespace outright.
 * `null` means the sysctl key doesn't exist (not that distro/config), which
 * is not itself an error. */
function apparmorRestrictsUnprivilegedUserns(): boolean | null {
  try {
    const out = execFileSync("sysctl", ["-n", "kernel.apparmor_restrict_unprivileged_userns"], {
      encoding: "utf8",
    }).trim();
    return out === "1";
  } catch {
    return null;
  }
}

/**
 * Startup preflight (spec §Failure semantics): platform support, srt's own
 * dependency check (bwrap/socat/seccomp on Linux; `sandbox-exec` presence is
 * implied by `isSupportedPlatform()` on macOS), and the Ubuntu 24.04+
 * AppArmor gate srt does not check itself. Called once at server boot and
 * cached — a run started while `ok: false` must fail before its first
 * iteration, never fall back to unsandboxed silently.
 */
export function sandboxPreflight(): SandboxPreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!SandboxManager.isSupportedPlatform()) {
    errors.push(
      `unsupported platform for sandboxing: ${process.platform}. Radulf's sandboxEnabled setting ` +
        "requires macOS or Linux (including WSL2) — native Windows and WSL1 are not supported.",
    );
    return { ok: false, errors, warnings };
  }
  if (process.platform === "linux" && apparmorRestrictsUnprivilegedUserns() === true) {
    errors.push(
      "kernel.apparmor_restrict_unprivileged_userns=1 blocks bubblewrap's unprivileged user " +
        "namespace (the Ubuntu 24.04+ default). Grant bwrap the userns capability via an AppArmor " +
        "profile, or set the sysctl to 0, then restart Radulf. See README's Linux support section.",
    );
  }
  const dep = SandboxManager.checkDependencies();
  errors.push(...dep.errors);
  warnings.push(...dep.warnings);
  return { ok: errors.length === 0, errors, warnings };
}

let readyPromise: Promise<SandboxPreflightResult> | null = null;

/**
 * Idempotent, process-wide: preflight once, then `SandboxManager.initialize()`
 * once with a maximally-restrictive floor (every real run supplies its own
 * full per-call filesystem/network config via `wrapWithSandbox`'s
 * `customConfig`, so the session baseline only matters as the fail-safe
 * default). Call at server boot; callers before a run's first bash call
 * await the cached result and fail the run, never proceed unsandboxed,
 * when `ok` is false.
 */
export function initializeSandboxRuntimeOnce(): Promise<SandboxPreflightResult> {
  if (!readyPromise) {
    readyPromise = (async () => {
      const preflight = sandboxPreflight();
      if (!preflight.ok) return preflight;
      let probeDir: string | undefined;
      try {
        await SandboxManager.initialize({
          filesystem: { denyRead: [HOME], allowWrite: [], denyWrite: [] },
          network: { allowedDomains: [], deniedDomains: [] },
        });
        // Dependency presence on the host does not prove that the sandbox can
        // start: denyRead can hide srt's own executable under $HOME.
        probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-sandbox-preflight-"));
        const wrapped = await SandboxManager.wrapWithSandbox("true", "/bin/bash", {
          filesystem: buildFilesystemConfig({
            worktree: probeDir,
            gitCommonDir: probeDir,
            tmpdir: probeDir,
            cacheRoot: probeDir,
          }),
        });
        await execFileAsync("/bin/bash", ["-c", wrapped], { cwd: probeDir, timeout: 10_000 });
        return preflight;
      } catch (e) {
        return {
          ok: false,
          errors: [...preflight.errors, `sandbox startup failed: ${e instanceof Error ? e.message : String(e)}`],
          warnings: preflight.warnings,
        };
      } finally {
        if (probeDir) fs.rmSync(probeDir, { recursive: true, force: true });
      }
    })();
  }
  return readyPromise;
}

/** Test-only: forget the cached init result so the next call re-runs it. */
export function resetSandboxRuntimeForTests(): void {
  readyPromise = null;
}

/**
 * Serializing queue for `wrapBashCommand` (PLAN.md Phase 18.2, superseding
 * Phase 4's hard-throw guard below). `sandboxQueueTail` is a promise-chain
 * mutex: each call captures the current tail, replaces it with its own
 * "done" promise, then awaits the tail it captured — so calls run their
 * wrap-and-`updateConfig` step one at a time, in arrival order, without
 * rejecting any of them. `queueDepth`/`queuedConfig` exist only for the
 * narrower safety check kept below: don't delete either without first
 * making network policy genuinely per-call (today it's always derived from
 * global settings, so it can never actually differ across calls — see the
 * check itself for why that's still verified at runtime, not assumed).
 */
let sandboxQueueTail: Promise<void> = Promise.resolve();
let queueDepth = 0;

/**
 * The only slice of `SandboxRuntimeConfig` that `updateConfig()` actually
 * mutates process-wide (see `wrapBashCommand`'s doc comment). Deliberately
 * excludes `filesystem`: that's per-call `customConfig` built fresh from
 * per-run paths (`buildFilesystemConfig`'s `worktree`/`tmpdir`/`cacheRoot`/
 * `gitCommonDir`), unique to every run by construction (PLAN.md Phase 19.1
 * — comparing the whole config made every concurrent pair "different" and
 * defeated 18.2's own fix).
 */
type NetworkPolicySlice = {
  network: SandboxRuntimeConfig["network"];
  enableWeakerNetworkIsolation?: boolean;
};

function networkPolicySlice(runConfig: SandboxRuntimeConfig): NetworkPolicySlice {
  return {
    network: runConfig.network,
    enableWeakerNetworkIsolation: runConfig.enableWeakerNetworkIsolation,
  };
}

let queuedConfig: NetworkPolicySlice | null = null;

/** Order-independent-on-keys, order-dependent-on-arrays structural equality
 * over plain JSON-shaped values — enough for a `NetworkPolicySlice` (strings,
 * booleans, arrays of strings), and deliberately not a `JSON.stringify`
 * comparison, which would be fooled by key-order differences from anywhere
 * that ever builds the config object differently than `buildRunSandboxConfig`
 * does today. */
function sandboxConfigsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => sandboxConfigsEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (k) =>
        Object.hasOwn(b as Record<string, unknown>, k) &&
        sandboxConfigsEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

/**
 * `SandboxManager.wrapWithSandbox` returns the srt-wrapped command string —
 * ready to hand to a shell exactly like the unwrapped command was.
 *
 * **Load-bearing quirk, found via the spec 14 Phase 6 positive control (a
 * real `npm install` was denied with `blocked-by-allowlist` even though the
 * run's config explicitly allowed `registry.npmjs.org`):** filesystem
 * policy is generated fresh per call from `wrapWithSandbox`'s `customConfig`
 * (confirmed in the Phase 5 spike and still true), but **network policy is
 * not** — the egress proxy is a long-running background process that
 * filters every request against the *session-level* config captured at
 * `initialize()`/`updateConfig()` time, never against a given call's
 * `customConfig.network`. Passing a run's `allowedDomains` only as
 * `customConfig` silently does nothing for network — proven live: identical
 * `customConfig`, `curl` denied before `updateConfig()`, allowed after.
 * `updateConfig()` mutates session-wide state, so every call's
 * wrap-and-`updateConfig` step is serialized against every other's via the
 * queue above (PLAN.md Phase 18.2) — Radulf's pipeline is no longer strictly
 * serial end-to-end (Phase 10: one loop per repo), but this specific window
 * still must be, since two interleaved `updateConfig()` calls could apply
 * the wrong run's network allowlist to the other's request.
 */
export async function wrapBashCommand(
  command: string,
  runConfig: SandboxRuntimeConfig,
): Promise<string> {
  // Real (not hardcoded-"always equal") safety check: today every caller's
  // config is derived from the same global settings, so this never actually
  // trips — but if per-run network policy is ever added, two genuinely
  // different concurrent configs must still fail loudly rather than one
  // silently overwriting the other's `updateConfig()` call. Compares only
  // the network-policy slice (PLAN.md Phase 19.1) — the per-run filesystem
  // config is expected to differ on every call and must never factor in.
  const incomingPolicy = networkPolicySlice(runConfig);
  if (queueDepth > 0 && queuedConfig !== null && !sandboxConfigsEqual(queuedConfig, incomingPolicy)) {
    throw new Error(
      "sandbox network policy is process-wide (see wrapBashCommand's doc comment) — a concurrent " +
        "sandboxed call is using a DIFFERENT network policy; applying this one now would silently " +
        "clobber it, so refusing to start it",
    );
  }
  queuedConfig = incomingPolicy;
  queueDepth++;
  const myTurn = sandboxQueueTail;
  let releaseMyTurn!: () => void;
  sandboxQueueTail = new Promise<void>((resolve) => {
    releaseMyTurn = resolve;
  });
  await myTurn;
  try {
    SandboxManager.updateConfig(runConfig);
    return await SandboxManager.wrapWithSandbox(command, undefined, runConfig);
  } finally {
    queueDepth--;
    releaseMyTurn();
  }
}

/**
 * A `BashOperations` implementation that srt-wraps every command before
 * delegating to pi's own local shell exec unchanged. This is `pi`'s
 * documented extension point for exactly this ("wrapping or rewriting
 * commands") — `spawnHook` cannot do it because it is synchronous and
 * `wrapWithSandbox` is async (spec 14 Phase 6 amendment: the original plan
 * named `spawnHook`, but the SDK's `BashSpawnHook` type is
 * `(ctx) => ctx`, not `Promise<ctx>`).
 */
export function createSandboxedBashOperations(runConfig: SandboxRuntimeConfig): BashOperations {
  const local = createLocalBashOperations();
  return {
    async exec(command, cwd, options) {
      const wrapped = await wrapBashCommand(command, runConfig);
      return local.exec(wrapped, cwd, options);
    },
  };
}
