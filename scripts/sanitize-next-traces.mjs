import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SENSITIVE_ROOTS = [
  ".agents",
  ".codex",
  ".git",
  "data",
  "runtmp",
  "worktrees",
  path.join("benchmarks", "reports"),
];

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
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
  for (const manifestPath of walk(nextDir)) {
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

  for (const manifestPath of walk(nextDir)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const leaked = Array.isArray(manifest.files)
      ? manifest.files.find(
          (file) => typeof file === "string" && isSensitive(file, path.dirname(manifestPath), projectRoot),
        )
      : undefined;
    if (leaked) throw new Error(`sensitive trace entry remains in ${manifestPath}: ${leaked}`);
  }
  return removed;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const removed = sanitizeTraceManifests();
  console.log(`Removed ${removed} sensitive Next.js trace entries`);
}
