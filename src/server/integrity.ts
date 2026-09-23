import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/db";
import { tryGit } from "./git";

/**
 * Parent-repo integrity check (spec 14 L3). A worktree shares the parent
 * repo's `.git`, so agent git can plant hooks or move refs in the REAL repo —
 * a planted hook fires later when the orchestrator runs `git merge` in the
 * user's checkout, which is deliberately trusted.
 *
 * Baseline at run start; full check (hooks + config + refs) at run end AFTER
 * process-group reaping; hook/config portion re-checked immediately before
 * merge, however long the card sat in In Review. The pre-merge check is the
 * load-bearing one — the run-end check exists to surface a violation while
 * the context is fresh.
 */

export type RepoIntegrityBaseline = {
  /** hook file name → sha256 of contents. */
  hooks: Record<string, string>;
  /** sha256 of .git/config ("" when absent). */
  configHash: string;
  /** refname → object id, from for-each-ref. */
  refs: Record<string, string>;
};

function sha256(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** Read the exact bytes being approved; never include config contents in events. */
export async function readRepoConfig(repoPath: string) {
  const commonDir = await gitCommonDir(repoPath);
  if (!commonDir) throw new Error("repository is no longer usable");
  try {
    const bytes = fs.readFileSync(path.join(commonDir, "config"));
    return { content: bytes.toString("utf8"), configHash: sha256(bytes) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { content: null, configHash: "" };
    }
    throw error;
  }
}

/** Resolve the shared .git dir; null when the path is not a usable repo. */
async function gitCommonDir(repoPath: string): Promise<string | null> {
  const { ok, out } = await tryGit(repoPath, "rev-parse", "--git-common-dir");
  if (!ok || !out) return null;
  return path.isAbsolute(out) ? out : path.join(repoPath, out);
}

/** Hook files that exist and are non-sample, hashed. */
function snapshotHooks(hooksDir: string): Record<string, string> {
  const hooks: Record<string, string> = {};
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(hooksDir);
  } catch {
    return hooks;
  }
  for (const name of entries) {
    if (name.endsWith(".sample")) continue;
    try {
      const p = path.join(hooksDir, name);
      if (fs.statSync(p).isFile()) hooks[name] = sha256(fs.readFileSync(p));
    } catch {
      // Vanished between readdir and read — treat as absent.
    }
  }
  return hooks;
}

/** The hook and config half of a baseline: what the pre-merge check re-reads
 * on its own, refs aside. */
function snapshotHooksAndConfig(
  commonDir: string,
): Pick<RepoIntegrityBaseline, "hooks" | "configHash"> {
  let configHash = "";
  try {
    configHash = sha256(fs.readFileSync(path.join(commonDir, "config")));
  } catch {
    // No config file — "" stands in, on both sides of the comparison.
  }
  return { hooks: snapshotHooks(path.join(commonDir, "hooks")), configHash };
}

async function snapshotRefs(repoPath: string): Promise<Record<string, string>> {
  const { ok, out } = await tryGit(
    repoPath,
    "for-each-ref",
    "--format=%(refname) %(objectname)",
  );
  const refs: Record<string, string> = {};
  if (!ok) return refs;
  for (const line of out.split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0) refs[line.slice(0, space)] = line.slice(space + 1);
  }
  return refs;
}

/** Null when the repo path is not a usable git repo — callers then skip the
 * integrity checks for this run rather than failing every run on a broken
 * repo record. */
export async function snapshotRepoIntegrity(
  repoPath: string,
): Promise<RepoIntegrityBaseline | null> {
  const commonDir = await gitCommonDir(repoPath);
  if (commonDir === null) return null;
  return { ...snapshotHooksAndConfig(commonDir), refs: await snapshotRefs(repoPath) };
}

/**
 * Refs Radulf writes on its own behalf, by name. Local branches under
 * `ralph/`: a card's run branch (`ralph/<slug>-<runId>`, `git.ts`) and an
 * improvement run's feature branch (`ralph/improve-<ts>`,
 * `improvementRuns.ts`). Plus their remote-tracking counterparts, which spec
 * 15 delivery creates when it pushes a branch to open a pull request (spec
 * 20). Nothing else in the server writes a ref by name.
 */
function isManagedRef(ref: string): boolean {
  return ref.startsWith("refs/heads/ralph/") || /^refs\/remotes\/[^/]+\/ralph\//.test(ref);
}

/**
 * Compare the repo against a baseline. Returns human-readable violations —
 * empty means intact. `runBranch` (e.g. "ralph/slug-runid") is the run's own
 * branch; with `checkRefs: false` only the hook/config portion runs (the
 * pre-merge check, where the base branch and other refs may have moved
 * legitimately since run end).
 *
 * Spec 19: the refs portion skips the whole `refs/heads/ralph/` namespace,
 * not just `runBranch`. Every worktree shares one `.git`, so a sibling card's
 * commit, a worktree cleanup and an improvement run's new branch all land in
 * this run's ref snapshot, where they read as tampering even though Radulf
 * wrote them itself. Refs outside that namespace (base branches, `main`,
 * tags, remotes) are still compared, and hooks and `.git/config` are
 * untouched by this.
 */
export async function checkRepoIntegrity(
  repoPath: string,
  baseline: RepoIntegrityBaseline,
  opts: { runBranch: string; checkRefs: boolean },
): Promise<string[]> {
  const violations: string[] = [];
  const commonDir = await gitCommonDir(repoPath);
  if (commonDir === null) {
    return [`repo at ${repoPath} is no longer a usable git repository`];
  }

  const { hooks: hooksNow, configHash } = snapshotHooksAndConfig(commonDir);
  for (const [name, hash] of Object.entries(hooksNow)) {
    if (!(name in baseline.hooks)) violations.push(`hook appeared: .git/hooks/${name}`);
    else if (baseline.hooks[name] !== hash) violations.push(`hook changed: .git/hooks/${name}`);
  }
  for (const name of Object.keys(baseline.hooks)) {
    if (!(name in hooksNow)) violations.push(`hook removed: .git/hooks/${name}`);
  }

  if (configHash !== baseline.configHash) violations.push(".git/config changed");

  if (opts.checkRefs) {
    const allowed = `refs/heads/${opts.runBranch}`;
    const managed = (ref: string) => ref === allowed || isManagedRef(ref);
    const refsNow = await snapshotRefs(repoPath);
    for (const [ref, oid] of Object.entries(refsNow)) {
      if (managed(ref)) continue;
      if (!(ref in baseline.refs)) violations.push(`ref appeared: ${ref}`);
      else if (baseline.refs[ref] !== oid) {
        violations.push(`ref moved: ${ref} (${baseline.refs[ref].slice(0, 12)} → ${oid.slice(0, 12)})`);
      }
    }
    for (const ref of Object.keys(baseline.refs)) {
      if (!managed(ref) && !(ref in refsNow)) violations.push(`ref deleted: ${ref}`);
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Durable baselines — the pre-merge check may run long after the run ended,
// across server restarts, so baselines persist per run under data/.
// ---------------------------------------------------------------------------

function baselineDir(): string {
  return path.join(DATA_DIR, "integrity");
}

function baselinePath(runId: string): string {
  return path.join(baselineDir(), `${runId}.json`);
}

export function saveBaseline(runId: string, baseline: RepoIntegrityBaseline): void {
  fs.mkdirSync(baselineDir(), { recursive: true });
  fs.writeFileSync(baselinePath(runId), JSON.stringify(baseline));
}

export function loadBaseline(runId: string): RepoIntegrityBaseline | null {
  try {
    return JSON.parse(fs.readFileSync(baselinePath(runId), "utf8")) as RepoIntegrityBaseline;
  } catch {
    return null; // Pre-spec-14 run — nothing to compare against.
  }
}

export function removeBaseline(runId: string): void {
  fs.rmSync(baselinePath(runId), { force: true });
}

// ---------------------------------------------------------------------------
// Live baselines (spec 20) — the in-memory copy a run is actually checked
// against, so Radulf can record a ref it moved itself while the run is open.
// ---------------------------------------------------------------------------

/** runId -> the repo it watches and the baseline it will be checked against. */
const liveBaselines = new Map<string, { repoPath: string; baseline: RepoIntegrityBaseline }>();

/** Register a run's baseline for the duration of the run. The entry holds the
 * caller's own object rather than a copy, so a `noteRadulfRefWrite` reaches
 * the baseline the run is checked against without the run re-reading it.
 * Always paired with `releaseRunBaseline` in a finally, or a long-lived server
 * leaks one entry per run. */
export function registerRunBaseline(
  runId: string,
  repoPath: string,
  baseline: RepoIntegrityBaseline,
): void {
  liveBaselines.set(runId, { repoPath, baseline });
}

export function releaseRunBaseline(runId: string): void {
  liveBaselines.delete(runId);
}

/**
 * Record a ref Radulf itself just wrote, so the runs open against that repo do
 * not report the server's own work as tampering (spec 20).
 *
 * Used for the base branch after an approved merge: every other card looping
 * in that repo holds a baseline that still has the pre-merge oid, and the base
 * branch is deliberately NOT in the managed namespace, because a human reviews
 * a run branch against its base and tampering with base is invisible to that
 * review. Telling the baselines what moved keeps the check's teeth while
 * removing the false positive.
 *
 * `repoPath` is matched exactly, as the repo record stores it, which is also
 * what every caller passes to `snapshotRepoIntegrity`.
 */
export function noteRadulfRefWrite(repoPath: string, ref: string, oid: string): void {
  for (const entry of liveBaselines.values()) {
    if (entry.repoPath === repoPath) entry.baseline.refs[ref] = oid;
  }
}
