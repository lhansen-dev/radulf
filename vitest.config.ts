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
      // Benchmark seed suites are node:test files run inside benchmark repos
      "benchmarks/**",
      // Ralph loop worktrees carry their own copies of the test suite
      "data/**",
    ],
  },
});
