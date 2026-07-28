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
 * Extract the affected worktree-relative paths from `git status --porcelain`
 * output. Renames (`R  old -> new`) report the destination — the path that now
 * exists in the tree.
 */
export function changedPaths(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const rest = line.slice(3);
      const arrow = rest.indexOf(" -> ");
      const p = arrow === -1 ? rest : rest.slice(arrow + 4);
      return p.replace(/^"(.*)"$/, "$1");
    });
}
