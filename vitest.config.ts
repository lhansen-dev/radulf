import { defineConfig, configDefaults } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    exclude: [
      ...configDefaults.exclude,
      // Benchmark seed suites are node:test files run inside benchmark repos.
      // Narrowed to seed/ so benchmarks/run-benchmark.test.mjs, which covers
      // the runner itself, still runs under vitest.
      "benchmarks/*/seed/**",
      // Ralph loop worktrees carry their own copies of the test suite
      "data/**",
    ],
  },
});
