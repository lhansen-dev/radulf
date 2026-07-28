import { describe, it, expect } from "vitest";
import { classifySensitivePaths, changedIgnoreFiles } from "./sensitivePaths";

describe("classifySensitivePaths", () => {
  it("returns [] for an ordinary application change", () => {
    expect(classifySensitivePaths(["src/app/card/[id]/page.tsx"])).toEqual([]);
  });

  it("flags sandbox/containment files", () => {
    const result = classifySensitivePaths([
      "src/server/sandbox/pathGuard.ts",
      "src/server/harness/pi.ts",
      "src/server/integrity.ts",
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("sandbox / containment policy");
    expect(result[0].paths).toHaveLength(3);
  });

  it("flags the settings store separately from sandbox files", () => {
    const result = classifySensitivePaths(["src/server/settings.ts", "src/server/sandbox/context.ts"]);
    expect(result.map((r) => r.label).sort()).toEqual(["sandbox / containment policy", "settings store"]);
  });

  it("flags authentication paths", () => {
    const result = classifySensitivePaths([
      "src/server/authSecret.ts",
      "src/server/session.ts",
      "src/proxy.ts",
      "src/app/api/auth/login/route.ts",
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("authentication");
    expect(result[0].paths).toHaveLength(4);
  });

  it("flags the merge/review path", () => {
    const result = classifySensitivePaths(["src/server/git.ts", "src/server/reviewService.ts"]);
    expect(result).toEqual([{ label: "merge / review path", paths: ["src/server/git.ts", "src/server/reviewService.ts"] }]);
  });

  it("does not flag unrelated server files", () => {
    expect(classifySensitivePaths(["src/server/bookkeeping.ts"])).toEqual([]);
  });
});

describe("changedIgnoreFiles", () => {
  it("returns [] when neither ignore file changed", () => {
    expect(changedIgnoreFiles(["src/app/page.tsx", "README.md"])).toEqual([]);
  });

  it("catches a root .gitignore and a nested .gitattributes", () => {
    expect(changedIgnoreFiles([".gitignore", "packages/foo/.gitattributes"])).toEqual([
      ".gitignore",
      "packages/foo/.gitattributes",
    ]);
  });
});
