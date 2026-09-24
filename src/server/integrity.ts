import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, asc, eq, gte } from "drizzle-orm";
import { DATA_DIR, db, now, refWrites } from "@/db";
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
  /** ISO timestamp taken BEFORE the refs were read, so a `ref_writes` row
   * written while the snapshot was in progress still counts as "since".
   * Missing on baselines persisted before spec 25 — read as "". */
  capturedAt: string;
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
  const capturedAt = new Date().toISOString();
  return { ...snapshotHooksAndConfig(commonDir), refs: await snapshotRefs(repoPath), capturedAt };
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
    // Spec 25 decision 6: refs Radulf moved itself since the baseline was
    // taken (a delivery worker's approved merge on the base branch) are not
    // tampering, provided the ref now sits exactly where we left it.
    const written = refWritesSince(repoPath, baseline.capturedAt ?? "");
    for (const [ref, oid] of Object.entries(refsNow)) {
      if (managed(ref)) continue;
      if (written.get(ref) === oid) continue;
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
// Ref writes (spec 20 / spec 25 decision 6) — the durable record of refs
// Radulf moved itself, so runs open against that repo in ANY process do not
// report the server's own work as tampering.
// ---------------------------------------------------------------------------

/**
 * Record a ref Radulf itself just wrote. Used for the base branch after an
 * approved merge: every other card looping in that repo holds a baseline that
 * still has the pre-merge oid, and the base branch is deliberately NOT in the
 * managed namespace, because a human reviews a run branch against its base
 * and tampering with base is invisible to that review. Recording what moved
 * keeps the check's teeth while removing the false positive.
 *
 * `repoPath` is matched exactly, as the repo record stores it, which is also
 * what every caller passes to `snapshotRepoIntegrity`.
 */
export function recordRefWrite(
  repoPath: string,
  ref: string,
  sha: string,
  workerId: string | null,
): void {
  db.insert(refWrites).values({ repoPath, ref, sha, workerId, writtenAt: now() }).run();
}

/** ref → the latest sha Radulf wrote to it in `repoPath` at or after
 * `sinceIso`. Rows are applied in id order, so a later write wins. */
export function refWritesSince(repoPath: string, sinceIso: string): Map<string, string> {
  const rows = db
    .select({ ref: refWrites.ref, sha: refWrites.sha })
    .from(refWrites)
    .where(and(eq(refWrites.repoPath, repoPath), gte(refWrites.writtenAt, sinceIso)))
    .orderBy(asc(refWrites.id))
    .all();
  const latest = new Map<string, string>();
  for (const row of rows) latest.set(row.ref, row.sha);
  return latest;
}
