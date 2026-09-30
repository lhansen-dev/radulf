import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Also the source of next.config.ts's `outputFileTracingExcludes`. */
export const SENSITIVE_ROOTS = [
  ".agents",
  ".codex",
  ".git",
  "data",
  "runtmp",
  "worktrees",
  path.join("benchmarks", "reports"),
];

// The build cache holds compiler state, not the trace manifests the
// standalone output is assembled from, and it is by far the largest tree.
function walk(dir, skip = new Set()) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (skip.has(full)) continue;
    if (entry.isDirectory()) files.push(...walk(full, skip));
    else if (entry.isFile() && entry.name.endsWith(".nft.json")) files.push(full);
  }
  return files;
}

function isSensitive(file, manifestDir, projectRoot) {
  const absolute = path.resolve(manifestDir, file);
  const relative = path.relative(projectRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  if (path.basename(relative).startsWith(".env")) return true;
  return SENSITIVE_ROOTS.some(
    (root) => relative === root || relative.startsWith(`${root}${path.sep}`),
  );
}

export function sanitizeTraceManifests(projectRoot = process.cwd()) {
  const nextDir = path.join(projectRoot, ".next");
  if (!fs.existsSync(nextDir)) throw new Error(".next does not exist; run next build first");
  let removed = 0;
  for (const manifestPath of walk(nextDir, new Set([path.join(nextDir, "cache")]))) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!Array.isArray(manifest.files)) continue;
    const safe = manifest.files.filter((file) => {
      const remove = typeof file === "string" && isSensitive(file, path.dirname(manifestPath), projectRoot);
      if (remove) removed++;
      return !remove;
    });
    if (safe.length !== manifest.files.length) {
      fs.writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, files: safe })}\n`, { mode: 0o600 });
    }
  }
  return removed;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const removed = sanitizeTraceManifests();
  console.log(`Removed ${removed} sensitive Next.js trace entries`);
}
