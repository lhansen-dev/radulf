import { describe, expect, it } from "vitest";
import { isDocPath, changedPaths } from "./docPaths";

describe("isDocPath", () => {
  it("allows the default doc roots and top-level markdown", () => {
    for (const p of [
      "specs/14-sandboxing.md",
      "docs/architecture/overview.md",
      "README.md",
      "README",
      "CHANGELOG.md",
      "./specs/00-overview.md",
    ]) {
      expect(isDocPath(p)).toBe(true);
    }
  });

  it("rejects code, nested non-doc markdown, and traversal", () => {
    for (const p of [
      "src/server/orchestrator.ts",
      "src/app/page.tsx",
      "package.json",
      "src/prompts/evaluate.md", // nested .md is not a doc path
      "../secrets.md",
      "specs/../src/evil.ts",
      "",
    ]) {
      expect(isDocPath(p)).toBe(false);
    }
  });
});

describe("changedPaths", () => {
  it("extracts paths from NUL-delimited porcelain, taking both rename identities", () => {
    const porcelain = [
      " M specs/14-sandboxing.md",
      "?? docs/new.md",
      "R  docs/renamed.md",
      "docs/old.md",
      "",
    ].join("\0");
    expect(changedPaths(porcelain)).toEqual([
      "specs/14-sandboxing.md",
      "docs/new.md",
      "docs/renamed.md",
      "docs/old.md",
    ]);
  });

  it("does not confuse a rename source containing the display arrow for its destination", () => {
    expect(changedPaths("R  src/server/auth.ts\0old -> docs/cover.md\0")).toEqual([
      "src/server/auth.ts",
      "old -> docs/cover.md",
    ]);
  });

  it("retains a rename source so moving code into docs is not authorized", () => {
    expect(changedPaths("R  docs/auth.md\0src/server/auth.ts\0")).toEqual([
      "docs/auth.md",
      "src/server/auth.ts",
    ]);
  });

  it("preserves every byte spelling Git emits for unusual paths", () => {
    const paths = [
      " docs/leading space.md",
      'docs/a "quote".md',
      String.raw`docs/a\backslash.md`,
      "docs/a\tcontrol.md",
      "docs/café.md",
    ];
    const porcelain = paths.map((path) => `?? ${path}\0`).join("");
    expect(changedPaths(porcelain)).toEqual(paths);
  });
});
