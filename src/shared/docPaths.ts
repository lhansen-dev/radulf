/**
 * Spec 14 doc allowlist. The evaluator may write these paths (and only these,
 * outside `.ralph/`) when it refreshes stale documentation on approve; the
 * narrowed post-run integrity check (`evaluationService`) rejects any other
 * changed path. Code and Git history stay immutable so the judge provably
 * cannot edit the implementation it just judged.
 *
 * Default set: everything under `specs/` and `docs/`, plus top-level markdown
 * and any top-level `README*`. Symlink/traversal tricks (`..`) never qualify.
 */
export function isDocPath(relPath: string): boolean {
  const p = relPath.replace(/^\.\//, "").replace(/^\/+/, "");
  if (!p || p.split("/").includes("..")) return false;
  if (p.startsWith("specs/") || p.startsWith("docs/")) return true;
  if (!p.includes("/")) {
    if (p.endsWith(".md")) return true;
    if (/^README/i.test(p)) return true;
  }
  return false;
}

/**
 * Extract affected paths from the exact output of
 * `git status --porcelain=v1 -z`. The NUL form never quotes path names and
 * emits a rename destination first, followed by a separate source record.
 * Both identities are security-relevant: allowing only the destination would
 * let an evaluator move implementation code into an allowed documentation
 * path and thereby delete the implementation.
 * Human-readable arrow parsing is intentionally unsupported because the
 * arrow may be part of a valid file name.
 */
export function changedPaths(porcelain: string): string[] {
  const records = porcelain.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record) continue;
    const status = record.slice(0, 2);
    paths.push(record[2] === " " ? record.slice(3) : record);
    if (status.includes("R") || status.includes("C")) {
      const source = records[i + 1];
      if (source) paths.push(source);
      i += 1;
    }
  }
  return paths;
}
