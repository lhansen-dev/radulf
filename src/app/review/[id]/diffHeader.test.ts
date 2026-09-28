import { describe, expect, it } from "vitest";
import { diffHeaderPath, diffHeaderPaths, unquoteGitPath } from "./diffHeader";
import { changedIgnoreFiles, classifySensitivePaths } from "./sensitivePaths";
import { classifySelfModifying } from "./selfModifying";

describe("diffHeaderPath", () => {
  it("reads an ordinary header", () => {
    expect(diffHeaderPath("diff --git a/src/server/git.ts b/src/server/git.ts")).toBe(
      "src/server/git.ts",
    );
  });

  it("reads a path containing a space", () => {
    expect(diffHeaderPath("diff --git a/docs/my notes.md b/docs/my notes.md")).toBe(
      "docs/my notes.md",
    );
  });

  it("uses a rename destination as the primary path and retains both sides", () => {
    const line = "diff --git a/old.ts b/src/server/sandbox/new.ts";
    expect(diffHeaderPath(line)).toBe("src/server/sandbox/new.ts");
    expect(diffHeaderPaths(line)).toEqual({
      source: "old.ts",
      destination: "src/server/sandbox/new.ts",
    });
  });

  it("decodes the octal escapes git writes for a non-ASCII path", () => {
    // Verbatim git output with core.quotePath at its default.
    const line = String.raw`diff --git "a/src/server/sandbox/caf\303\251.ts" "b/src/server/sandbox/caf\303\251.ts"`;
    expect(diffHeaderPath(line)).toBe("src/server/sandbox/café.ts");
  });

  it("decodes a quoted path with an embedded quote, which core.quotePath never unquotes", () => {
    const line = String.raw`diff --git "a/src/server/sandbox/we\"ird.ts" "b/src/server/sandbox/we\"ird.ts"`;
    expect(diffHeaderPath(line)).toBe('src/server/sandbox/we"ird.ts');
  });

  it("decodes a quoted rename destination after an unquoted source", () => {
    const line = String.raw`diff --git a/old.ts "b/src/server/sandbox/caf\303\251.ts"`;
    expect(diffHeaderPaths(line)).toEqual({
      source: "old.ts",
      destination: "src/server/sandbox/café.ts",
    });
  });

  it("keeps a sensitive destination containing the delimiter text", () => {
    const line = "diff --git a/notes.txt b/src/server/sandbox/policy b/ignored.ts";
    const paths = diffHeaderPaths(line);
    expect(paths).toEqual({
      source: "notes.txt",
      destination: "src/server/sandbox/policy b/ignored.ts",
    });
    expect(classifySensitivePaths(Object.values(paths)).map((f) => f.label)).toContain(
      "sandbox / containment policy",
    );
  });

  it("decodes a backslash and a tab", () => {
    expect(unquoteGitPath(String.raw`"a\\b"`)).toBe("a\\b");
    expect(unquoteGitPath(String.raw`"a\tb"`)).toBe("a\tb");
  });

  it("falls back to the whole line rather than losing the entry", () => {
    expect(diffHeaderPath("diff --git something-unexpected")).toBe(
      "diff --git something-unexpected",
    );
  });
});

describe("the security banners this feeds", () => {
  // The bug: a quoted header left `classifySensitivePaths` matching against
  // `diff --git "a/..." "b/..."` instead of a path, so a change to containment
  // code under a non-ASCII filename raised no banner at all.
  const quoted = String.raw`diff --git "a/src/server/sandbox/caf\303\251.ts" "b/src/server/sandbox/caf\303\251.ts"`;

  it("raises the containment banner for a quoted path under src/server/sandbox/", () => {
    const flags = classifySensitivePaths([diffHeaderPath(quoted)]);
    expect(flags.map((f) => f.label)).toContain("sandbox / containment policy");
  });

  it("raises the self-modifying banner for the same path", () => {
    const flags = classifySelfModifying([diffHeaderPath(quoted)]);
    expect(flags.map((f) => f.label)).toContain("self-modifying: prompts/orchestrator");
  });

  it("raises both banners when only a rename destination is sensitive", () => {
    const renamed = "diff --git a/notes.txt b/src/server/sandbox/policy.ts";
    const paths = Object.values(diffHeaderPaths(renamed));
    expect(classifySensitivePaths(paths).map((f) => f.label)).toContain(
      "sandbox / containment policy",
    );
    expect(classifySelfModifying(paths).map((f) => f.label)).toContain(
      "self-modifying: prompts/orchestrator",
    );
  });

  it("flags an ignore file that is only the destination of a rename", () => {
    const renamed = "diff --git a/notes.txt b/.gitignore";
    expect(changedIgnoreFiles(Object.values(diffHeaderPaths(renamed)))).toEqual([".gitignore"]);
  });

  it("would have raised neither before the header was unquoted", () => {
    const old = quoted.replace(/^diff --git a\/(.*) b\/.*$/, "$1");
    expect(classifySensitivePaths([old])).toEqual([]);
    expect(classifySelfModifying([old])).toEqual([]);
  });
});
