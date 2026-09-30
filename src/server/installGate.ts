import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ApprovedInstallScript } from "@/db";
import { scriptKey } from "@/shared/installScripts";
import { errorMessage } from "@/shared/errorMessage";
import { execBounded } from "./exec";
import type { RunSandboxContext } from "./sandbox/context";
import { runSandboxedCommand } from "./sandbox/srt";

/**
 * The install-script gate (spec 14) — a supply-chain AWARENESS control, not a
 * containment one: its job is to put a human in front of "this install wants
 * to execute code from a package you haven't approved."
 *
 * Detection is STRUCTURAL, not textual: npm CLI flags override env config
 * (`npm install --ignore-scripts=false` beats `npm_config_ignore_scripts`),
 * and pattern-matching command strings is similarly weak. The gate therefore
 * inspects the resolved dependency tree on disk (node_modules) after the
 * iteration, triggered by a lockfile fingerprint change — it fires regardless
 * of how the install was invoked.
 *
 * This is NOT a permission prompt and decision 7 is intact: the model never
 * sees a prompt or an approve/deny tool; the run halts into Needs Attention
 * and a human decides out-of-band in the card UI.
 *
 * If a repo moves to pnpm, `onlyBuiltDependencies` is the native form of this
 * allowlist and replaces the enumeration step below.
 */

const LIFECYCLE_EVENTS = ["preinstall", "install", "postinstall", "prepare"] as const;

export type LifecycleScriptPackage = {
  name: string;
  version: string;
  /** The verbatim lifecycle script bodies, shown to the approving human. */
  scripts: Record<string, string>;
  scriptHash: string;
  /** node_modules dir the package was found in, relative to the scan root. */
  dir: string;
};

/** Stable hash of the lifecycle-script set — a version bump or edited script
 * body changes it and re-fires the gate. */
export function scriptHashFor(scripts: Record<string, string>): string {
  const canonical = LIFECYCLE_EVENTS.filter((e) => e in scripts)
    .map((e) => `${e}\n${scripts[e]}`)
    // NUL separator: it cannot occur in a script body, so no combination of
    // event names and bodies can collide by rearranging the join boundaries.
    // Written as an escape, never as a literal NUL — a raw NUL byte makes the
    // whole file "binary" to grep, file(1), and GitHub's diff renderer.
    .join("\n\u0000");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

const SCAN_SKIP = new Set([".git", ".ralph", ".next", "dist", "build", "out"]);

/** Find every node_modules root in the tree (monorepo installs land nested),
 * without descending into node_modules itself. */
export function findNodeModulesRoots(rootDir: string, maxDepth = 4): string[] {
  const roots: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(/* turbopackIgnore: true */ dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const full = path.join(/* turbopackIgnore: true */ dir, entry.name);
      if (entry.name === "node_modules") {
        roots.push(full);
        continue;
      }
      if (SCAN_SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
      if (depth < maxDepth) walk(full, depth + 1);
    }
  };
  walk(rootDir, 0);
  return roots;
}

async function readPackageScripts(pkgDir: string): Promise<LifecycleScriptPackage | null> {
  let parsed: { name?: unknown; version?: unknown; scripts?: unknown };
  try {
    parsed = JSON.parse(
      await fs.promises.readFile(path.join(/* turbopackIgnore: true */ pkgDir, "package.json"), "utf8"),
    );
  } catch {
    return null;
  }
  const allScripts =
    parsed.scripts && typeof parsed.scripts === "object"
      ? (parsed.scripts as Record<string, unknown>)
      : {};
  const scripts: Record<string, string> = {};
  for (const event of LIFECYCLE_EVENTS) {
    if (typeof allScripts[event] === "string") scripts[event] = allScripts[event] as string;
  }
  if (Object.keys(scripts).length === 0) return null;
  return {
    name: String(parsed.name ?? path.basename(pkgDir)),
    version: String(parsed.version ?? "0.0.0"),
    scripts,
    scriptHash: scriptHashFor(scripts),
    dir: pkgDir,
  };
}

/** Enumerate every installed package (in every node_modules root under
 * `rootDir`) that declares a lifecycle script. Reads every package.json in
 * the tree, so it is async: it runs on the loop path and on the approval
 * request, and neither should block the event loop for the walk. */
export async function collectLifecycleScripts(rootDir: string): Promise<LifecycleScriptPackage[]> {
  const found = new Map<string, LifecycleScriptPackage>();
  /** Directory entries, or none when the path is unreadable or not a directory. */
  const readDir = async (dir: string): Promise<fs.Dirent[]> => {
    try {
      return await fs.promises.readdir(/* turbopackIgnore: true */ dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  const scanNodeModules = async (nmDir: string) => {
    for (const entry of await readDir(nmDir)) {
      if (!entry.isDirectory() || entry.name === ".bin") continue;
      const full = path.join(/* turbopackIgnore: true */ nmDir, entry.name);
      if (entry.name.startsWith("@")) {
        for (const sub of await readDir(full)) {
          if (sub.isDirectory()) await visitPackage(path.join(/* turbopackIgnore: true */ full, sub.name));
        }
        continue;
      }
      if (entry.name.startsWith(".")) continue;
      await visitPackage(full);
    }
  };
  const visitPackage = async (pkgDir: string) => {
    const pkg = await readPackageScripts(pkgDir);
    if (pkg) found.set(scriptKey(pkg), pkg);
    // A package with no nested node_modules reads as an empty directory.
    await scanNodeModules(path.join(/* turbopackIgnore: true */ pkgDir, "node_modules"));
  };
  for (const nm of findNodeModulesRoots(rootDir)) await scanNodeModules(nm);
  return [...found.values()];
}

/** The packages whose lifecycle scripts no human has approved (keyed on
 * name + version + scriptHash — any change re-fires the gate). */
export function unapprovedScripts(
  found: LifecycleScriptPackage[],
  approved: ApprovedInstallScript[],
): LifecycleScriptPackage[] {
  const keys = new Set(approved.map(scriptKey));
  return found.filter((p) => !keys.has(scriptKey(p)));
}

const LOCKFILE_NAMES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  path.join("node_modules", ".package-lock.json"),
];

/**
 * Cheap per-iteration trigger: a fingerprint over every lockfile in the tree
 * (including node_modules/.package-lock.json, which changes even for
 * `--no-save` installs). A changed fingerprint means "an install happened —
 * scan the resolved tree."
 */
export function lockfileFingerprint(rootDir: string): string {
  const hash = crypto.createHash("sha256");
  const dirs = [rootDir, ...findNodeModulesRoots(rootDir).map((nm) => path.dirname(nm))];
  for (const dir of [...new Set(dirs)].sort()) {
    for (const name of LOCKFILE_NAMES) {
      const p = path.join(/* turbopackIgnore: true */ dir, name);
      try {
        const stat = fs.statSync(/* turbopackIgnore: true */ p);
        hash.update(`${path.relative(rootDir, p)}\n${stat.size}\n${stat.mtimeMs}\n`);
      } catch {
        // Absent — contributes nothing.
      }
    }
  }
  return hash.digest("hex");
}

// This is the one exec path whose entire purpose is running lifecycle
// scripts a human has just approved — a postinstall that hangs (stdin read,
// dead network mount) must not be able to freeze the whole app, since the
// orchestrator runs exactly one card at a time globally. A rebuild can
// legitimately compile native code, so the bound is generous: minutes, not
// seconds.
const REBUILD_TIMEOUT_MS = 5 * 60_000;
const REBUILD_MAX_BUFFER = 16 * 1024 * 1024;

export type NpmRunner = (args: string[], cwd: string) => Promise<{ ok: boolean; out: string }>;

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * An `npm` runner confined exactly as the agent's own bash is: the run's
 * allowlist env, its command preamble, and its L1 policy when the sandbox is
 * on. The approved script bodies are what the human read. Everything AROUND
 * them is agent-authored and earns no more trust at approval than it had
 * during the iteration that wrote it: the worktree's `.npmrc` (reproduced
 * pre-fix, `script-shell=` ran an agent script on the host in place of `sh`
 * for an approved package), `node-options`, the rest of the resolved tree.
 *
 * `--ignore-scripts=false` because the agent env sets
 * `npm_config_ignore_scripts=true`, and running the approved scripts is the
 * point. A CLI flag outranks env config — the same precedence the gate's
 * detection is built on.
 */
export function sandboxedNpmRunner(ctx: RunSandboxContext): NpmRunner {
  return async (args, cwd) => {
    const command = ["npm", ...args, "--ignore-scripts=false"].map(shellQuote).join(" ");
    // Same joining as the acceptance probe: the preamble's lines end in
    // `|| true`, so the command must start a line of its own.
    const prefixed = ctx.commandPrefix ? `${ctx.commandPrefix}\n${command}` : command;
    // execBounded rather than a bare exec: SIGTERM at the bound, SIGKILL
    // after, stdin closed — a postinstall that prompts or hangs fails instead
    // of wedging the approval route. Run inside the sandbox claim, not after
    // it: a rebuild is the network-heaviest thing Radulf runs, and the
    // process-wide egress policy has to stay this run's for its duration.
    const run = (toRun: string) =>
      execBounded("/bin/sh", ["-c", toRun], {
        cwd,
        env: ctx.env,
        timeoutMs: REBUILD_TIMEOUT_MS,
        maxBuffer: REBUILD_MAX_BUFFER,
      });
    let outcome: Awaited<ReturnType<typeof run>>;
    try {
      // Only the wrap can throw here — execBounded reports failures in its
      // result. Could not contain it, so do not run it.
      outcome = ctx.srtConfig
        ? await runSandboxedCommand(prefixed, ctx.srtConfig, run, { tmpdir: ctx.tmpdir })
        : await run(prefixed);
    } catch (e) {
      return { ok: false, out: `could not sandbox npm rebuild: ${errorMessage(e)}` };
    }
    const { err, stdout, stderr, timedOut } = outcome;
    const out = (stdout + stderr).trim();
    if (!err) return { ok: true, out };
    if (timedOut) {
      // Name the timeout instead of surfacing an opaque "Command failed" —
      // an operator seeing that with no reason is exactly the failure mode
      // `timedOut` exists to prevent.
      const msg = `npm ${args.join(" ")} timed out after ${REBUILD_TIMEOUT_MS}ms`;
      return { ok: false, out: out ? `${out}\n${msg}` : msg };
    }
    return { ok: false, out: out || err.message || "npm rebuild failed" };
  };
}

/**
 * Run `npm rebuild <pkg>` for the approved packages ONLY (per-package
 * granularity) — this executes the now-approved scripts, through `runNpm`,
 * which in production is `sandboxedNpmRunner`.
 */
export async function rebuildPackages(
  worktreePath: string,
  names: string[],
  runNpm: NpmRunner,
): Promise<{ ok: boolean; out: string }> {
  const outputs: string[] = [];
  for (const name of names) {
    const result = await runNpm(["rebuild", name], worktreePath);
    outputs.push(result.out);
    if (!result.ok) return { ok: false, out: outputs.filter(Boolean).join("\n") };
  }
  return { ok: true, out: outputs.filter(Boolean).join("\n") };
}
