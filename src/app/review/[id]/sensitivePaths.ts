/**
 * Distinct, louder warning than `classifySelfModifying`: paths that don't
 * just touch orchestrator code but touch the sandbox/security posture
 * itself — the containment the human reviewer is implicitly trusting when
 * they approve everything else. A self-target card (Radulf working on
 * Radulf) frequently lands here; that's the point, not a false positive.
 */
export function classifySensitivePaths(
  paths: string[],
): { label: string; paths: string[] }[] {
  const result: { label: string; paths: string[] }[] = [];

  const push = (label: string, matcher: (p: string) => boolean) => {
    const matched = paths.filter(matcher);
    if (matched.length > 0) result.push({ label, paths: matched });
  };

  push(
    "sandbox / containment policy",
    (p) => p.startsWith("src/server/sandbox/") || p.startsWith("src/server/harness/") ||
      p === "src/server/integrity.ts" || p === "src/server/installGate.ts",
  );
  push("settings store", (p) => p === "src/server/settings.ts");
  push(
    "authentication",
    (p) =>
      p === "src/server/authSecret.ts" ||
      p === "src/server/session.ts" ||
      p === "src/proxy.ts" ||
      p.startsWith("src/app/api/auth/"),
  );
  push(
    "merge / review path",
    (p) => p === "src/server/git.ts" || p === "src/server/reviewService.ts",
  );

  return result;
}

const IGNORE_FILE_BASENAMES = new Set([".gitignore", ".gitattributes"]);

/** `.gitignore`/`.gitattributes` changes get their own callout regardless of
 * where in the tree they live — either one can be used to hide a file from
 * `git add -A` or from how a diff renders. */
export function changedIgnoreFiles(paths: string[]): string[] {
  return paths.filter((p) => IGNORE_FILE_BASENAMES.has(p.split("/").pop() ?? ""));
}
