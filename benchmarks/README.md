# Benchmark Corpus

The repeatable benchmark corpus for spec 11 Phase 3 — evidence for routing,
provider, and model decisions. Four fixtures cover the representative shapes
of Radulf work:

| Fixture | Shape | Seeded |
|---|---|---|
| `snake-tui/` | Medium greenfield build (Python TUI + headless game logic) | no — starts from an empty repo |
| `small-ui-change/` | Small UI change in an existing codebase | yes |
| `server-data-change/` | Server/data change with validation edge cases | yes |
| `failing-test-repair/` | Diagnose planted bugs from failing tests | yes |

Each fixture is a directory with `TASK.md` (the card fed to the planner),
`CRITERIA.md` (machine-checkable acceptance commands run in the worktree),
and — for existing-codebase fixtures — `seed/`, the starting codebase.

## Runner

`run-benchmark.mjs` is a dependency-free Node (≥18) script shared by every
fixture. It creates a card per run through the Radulf API, waits for the
loop to finish, executes the fixture's criteria in the run's worktree, and
reports wall time, iterations, model turns, p50/p90 iteration time, token
and cost sums, criteria pass rate, and diff correctness, aggregated across
runs.

```bash
node benchmarks/run-benchmark.mjs \
  --fixture small-ui-change \
  --repo <registered-throwaway-repo-id> \
  --provider <provider> --model <model> \
  --planner-model <planner-model> \
  --password '<radulf-password>' \
  --runs 3 \
  --out benchmarks/reports/small-ui-change-$(date +%Y-%m-%d).json
```

`--provider` and `--model` identify the loop candidate. Planning can use a
different model via `--planner-model`; when omitted, it defaults to the loop
model for compatibility with older benchmark invocations. The planner model
runs through the planner provider configured in Radulf Settings.

`--dry-run` prints the plan without touching the server. See each fixture's
README and `node benchmarks/run-benchmark.mjs --help` for all options.

Benchmarks can also be launched from the **Benchmarks** page in the Radulf
UI, which shells out to this same runner and drops reports in
`benchmarks/reports/`.

## Ground rules (from spec 11 Phase 3)

- **Use a throwaway repo.** Seeded fixtures commit `seed/` into the repo, and
  every run starts with a hard reset to the pre-benchmark baseline commit —
  approved merges from earlier runs are discarded so runs stay identical.
- **Parallel loops are disabled** for the duration (`maxParallelLoops: 1`,
  restored afterwards): concurrency obscures per-loop latency.
- **Run each candidate at least 3 times** (`--runs`, default 3).
- **Promotion needs evidence**: no quality regression and at least a 20%
  median accepted-work wall-time improvement, or an explicit user-selected
  cost tradeoff. Single-fixture results are provisional.

Reports land in `benchmarks/reports/` (gitignored — they are local evidence,
not source).
