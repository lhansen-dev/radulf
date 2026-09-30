# Snake TUI Benchmark Fixture

A repeatable benchmark fixture for Radulf Phase 3 loop-performance testing.
The task is **"Create snake in a Python TUI"** — a medium greenfield build
starting from an empty repo.

## Preconditions

Before running a benchmark, ensure the following are in place:

1. **A running Radulf server** accessible at a base URL (default
   `http://localhost:3000`).
2. **A registered empty git repo** with an initial commit.  Use the
   Radulf UI or API to register a repo pointing to an empty (or minimal)
   git worktree on disk.  The repo must have at least one commit on its
   default branch.
3. **Candidate providers configured** in Radulf Settings (Planner Provider
   and Loop Provider). The runner accepts `--model` and `--planner-model`
   overrides that are passed as the card's `loopModel` and `plannerModel`.
4. **Authentication credentials** — either a session cookie value
   (`RADULF_BENCH_AUTH_COOKIE`, or `--auth-cookie`) or the server's auth
   password (`--password`).  If `--password` is used, the runner logs in via
   `POST /api/auth/login` and reads the `Set-Cookie` header automatically.
   Prefer the environment variable: a benchmark runs for hours, and a
   process's command line is readable by every account on the host for that
   whole time.  Launching from the Benchmarks page always uses it.

## Usage

The runner is shared by every fixture and lives at
`benchmarks/run-benchmark.mjs` (see `benchmarks/README.md`):

```
node benchmarks/run-benchmark.mjs --fixture snake-tui [options]
```

### Options

| Option | Default | Description |
|---|---|---|
| `--fixture` | *(required)* | Fixture directory name — `snake-tui` here |
| `--base-url` | `http://localhost:3000` | Radulf server base URL |
| `--repo` | *(required)* | Registered throwaway-repo ID |
| `--provider` | *(required)* | Loop provider name (e.g. `anthropic`, `openrouter`) |
| `--model` | *(required)* | Loop model name (e.g. `claude-sonnet-4-20250514`) |
| `--planner-model` | loop model | Planner model name; uses the planner provider from Settings |
| `--runs` | `3` | Number of benchmark runs |
| `--auth-cookie` | `$RADULF_BENCH_AUTH_COOKIE` | Session cookie value for authentication |
| `--password` | — | Password to POST `/api/auth/login` and read `Set-Cookie` |
| `--max-iterations` | *(default)* | Optional card `maxIterations` override |
| `--timeout-minutes` | *(default)* | Optional card `timeoutMinutes` override |
| `--auto-review` | off | Automatically approve/reject based on criteria pass |
| `--out` | *(stdout)* | Path to write the JSON report |
| `--dry-run` | off | Validate arguments, print the plan, exit 0 — no API calls |
| `--help` | — | Show usage and exit |

### Example

```bash
# Dry run — validate arguments and print the execution plan
node benchmarks/run-benchmark.mjs \
  --fixture snake-tui \
  --repo my-throwaway-repo \
  --provider anthropic \
  --model claude-sonnet-4-20250514 \
  --planner-model claude-opus-4-20250514 \
  --password 'my-radulf-password' \
  --runs 3 \
  --out benchmarks/reports/snake-tui-2026-07-15.json \
  --dry-run

# Real run — drop --dry-run
```

## Metrics Collected

For each run the runner records:

| Metric | Description |
|---|---|
| **Criteria pass** | Boolean — all CRITERIA.md commands exit 0 |
| **Diff correctness** | Boolean — non-empty diff AND criteria pass |
| **Total wall time** | `run.endedAt − run.startedAt` (ms) |
| **Iterations** | Number of iterations completed |
| **Model turns** | Sum of `iteration.modelTurns` across all iterations |
| **p50 iteration time** | Median iteration wall time (ms) |
| **p90 iteration time** | 90th percentile iteration wall time (ms) |
| **Uncached input tokens** | Sum of `iteration.promptTokens` |
| **Cached input tokens** | Sum of `iteration.cachedInputTokens` |
| **Output tokens** | Sum of `iteration.completionTokens` |
| **Reasoning tokens** | Sum of `iteration.reasoningTokens` |
| **Cost (USD)** | Sum of `iteration.costUsd` |
| **Review outcome** | `"pending"` if card is in `review`, otherwise the terminal status |

After all runs, the report aggregates across runs with min, max, median, p50,
p90, and mean for each numeric metric.  Criteria pass rate and diff
correctness rate are also reported.

## Parallel Loops

During a benchmark run, the runner **disables parallel loops** by setting
`maxParallelLoops: 1` via `PATCH /api/settings`.  The prior value is saved
and restored in a `finally` block, even if the runner encounters an error.
This ensures that concurrency does not mask per-loop latency or
rate-limiting effects.

## The Rest of the Corpus

This fixture covers the greenfield case. The existing-codebase fixtures live
alongside it — `small-ui-change`, `server-data-change`, and
`failing-test-repair` — see `benchmarks/README.md`. Promotion decisions
should weigh results across the whole corpus, not just this fixture.

## Files

| File | Description |
|---|---|
| `TASK.md` | Card content fed to the Radulf planner (title + description) |
| `CRITERIA.md` | Machine-checkable acceptance criteria commands |
| `README.md` | This file — documentation |
