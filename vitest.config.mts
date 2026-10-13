import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": `${import.meta.dirname}/src`,
    },
  },
  test: {
    // Node 25+ ships a global `localStorage` that, without --localstorage-file,
    // is undefined and shadows jsdom's — every component test touching storage
    // then fails on a current Node while CI's pinned Node 22 stays green.
    // Only where the flag exists (Node 22.4+): an unknown flag kills the workers.
    execArgv: process.allowedNodeEnvironmentFlags.has("--experimental-webstorage") ? ["--no-experimental-webstorage"] : [],
    // Tests `git init` scratch repos by the dozen; each printed git's
    // default-branch-name hint into the run log. Advice only: no git behaviour changes.
    env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "advice.defaultBranchName", GIT_CONFIG_VALUE_0: "false" },
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
