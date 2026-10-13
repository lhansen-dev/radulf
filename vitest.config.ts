import { defineConfig, configDefaults } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    // Node 25+ ships a global `localStorage` that, without --localstorage-file,
    // is undefined and shadows jsdom's — every component test touching storage
    // then fails on a current Node while CI's pinned Node 22 stays green.
    execArgv: ["--no-experimental-webstorage"],
    exclude: [
      ...configDefaults.exclude,
      // Benchmark seed suites are node:test files run inside benchmark repos.
      // Narrowed to seed/ so benchmarks/run-benchmark.test.mjs, which covers
      // the runner itself, still runs under vitest.
      "benchmarks/*/seed/**",
      // Runtime directories: agent worktrees carry their own copies of the
      // test suite. data/** stays for checkouts made under the legacy layout.
      "worktrees/**",
      "plans/**",
      "runtmp/**",
      "data/**",
    ],
  },
});
