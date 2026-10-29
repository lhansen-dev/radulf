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
    expect(classifySensitivePaths(["src/server/analytics.ts", "src/app/ui/api.ts"])).toEqual([]);
  });

  it("flags what runs commands under the run's policy as containment, and auto-approval as the merge path", () => {
    const result = classifySensitivePaths([
      "src/server/gate.ts",
      "src/server/acceptanceProbe.ts",
      "src/server/worktreeDeps.ts",
      "src/server/bookkeeping.ts",
      "src/server/evaluationService.ts",
      "src/server/improvementRuns.ts",
      "src/server/github.ts",
    ]);
    expect(result.map((r) => [r.label, r.paths.length])).toEqual([
      ["sandbox / containment policy", 4],
      ["merge / review path", 3],
    ]);
  });

  it("flags repository access and the build, dependency and deployment files", () => {
    const result = classifySensitivePaths([
      "src/server/repoClone.ts",
      "src/app/api/repos/clone/route.ts",
      "package.json",
      "package-lock.json",
      "Makefile",
      "Dockerfile",
      "compose.override.yaml",
      "next.config.ts",
      ".github/workflows/ci.yml",
      "scripts/sanitize-next-traces.mjs",
      "docs/compose.yaml",
    ]);
    expect(result.map((r) => [r.label, r.paths])).toEqual([
      ["repository access", ["src/server/repoClone.ts", "src/app/api/repos/clone/route.ts"]],
      [
        "build / dependencies / deployment",
        [
          "package.json",
          "package-lock.json",
          "Makefile",
          "Dockerfile",
          "compose.override.yaml",
          "next.config.ts",
          ".github/workflows/ci.yml",
          "scripts/sanitize-next-traces.mjs",
        ],
      ],
    ]);
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
