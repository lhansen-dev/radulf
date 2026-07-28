# Failing-Test Repair Benchmark Fixture

The **diagnosis fixture** of the Phase 3 corpus. The seed is a small
cart-pricing module whose test suite fails out of the box: 2 of 8 tests fail
because of two planted production bugs (a `>=` boundary written as `>`, and a
missing-quantity default of 0 instead of 1). The task is to read the failing
assertions, find the bugs in `src/cart.js`, and fix them — without touching
the tests, which is enforced by a sha256 pin on `test/cart.test.js`.

The shared runner commits `seed/` into the target repo before the first run
and hard-resets to that baseline between runs:

```bash
node benchmarks/run-benchmark.mjs --fixture failing-test-repair \
  --repo my-throwaway-repo --provider <p> --model <loop-model> \
  --planner-model <planner-model> --password <pw>
```

Criteria are machine-checkable with only Node ≥18 (no npm installs): the
full `node --test` suite must pass, the test file must be byte-identical to
the seed, and spot checks confirm the corrected pricing behavior.

| File | Description |
|---|---|
| `TASK.md` | Card content fed to the Radulf planner (title + description) |
| `CRITERIA.md` | Machine-checkable acceptance criteria commands |
| `seed/` | Starting codebase committed into the benchmark repo |
