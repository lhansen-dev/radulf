import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Worker bundle emitted by `make build-worker`.
    "dist/**",
    // Runtime directories: agent worktrees, plans, scratch space, and
    // transcripts/SQLite under data/ (which also holds legacy worktrees).
    "worktrees/**",
    "plans/**",
    "runtmp/**",
    "data/**",
    // Benchmark fixture seeds are standalone CommonJS apps, and the runner
    // is a dependency-free Node script — neither is part of the Next app.
    "benchmarks/**",
  ]),
]);

export default eslintConfig;
