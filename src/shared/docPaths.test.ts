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
  it("extracts paths from porcelain status, taking rename destinations", () => {
    const porcelain = [
      " M specs/14-sandboxing.md",
      "?? docs/new.md",
      "R  docs/old.md -> docs/renamed.md",
      "",
    ].join("\n");
    expect(changedPaths(porcelain)).toEqual([
      "specs/14-sandboxing.md",
      "docs/new.md",
      "docs/renamed.md",
    ]);
  });
});
