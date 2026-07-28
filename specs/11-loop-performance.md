# 11 — Ralph Loop Performance

Radulf should make the Ralph wheel turn quickly without trading away the
backpressure that makes the loop useful. A five-minute iteration is not
automatically broken: Ralph has no canonical per-iteration duration, and a
coherent task may legitimately need that long. In this repository, however,
five minutes is an **outlier worth investigating**, not a healthy steady state.

This spec adds accurate performance telemetry, removes avoidable model turns,
and introduces evidence-based provider/model tuning. It amends 09's claim that
the generated OpenCode agent already has a tight tool set: the current legacy
`tools` object does not deny omitted built-ins.

## Evidence snapshot

Snapshot taken 2026-07-13 PDT from `data/radulf.db`, the stored transcripts,
and OpenCode session exports. All durations are wall-clock.

### Last 10 completed loop runs

This is the broad recent baseline: 73 iterations across 10 successful runs.
Nine runs used the older Claude Code proxy path and the newest run used the
current OpenCode adapter, so this sample is useful for the overall user
experience but not for harness-to-harness comparison.

| Metric | Value |
|---|---:|
| Mean iteration | 135.9 s |
| Median iteration | 101.5 s |
| p75 / p90 / p95 | 182.9 / 271.4 / 334.0 s |
| Maximum | 625.9 s |
| Iterations at least 3 minutes | 19 / 73 (26.0%) |
| Iterations at least 5 minutes | 5 / 73 (6.8%) |

The recorded uncached-token bands are strongly associated with wall time, but
the existing `promptTokens` name is misleading because it sums every model
turn in an iteration and omits cache reads:

| Recorded uncached input | Iterations | Mean duration |
|---|---:|---:|
| under 75k | 19 | 65.3 s |
| 75k–150k | 25 | 94.5 s |
| 150k–300k | 22 | 182.3 s |
| 300k+ | 7 | 329.7 s |

This is cumulative work, not evidence that a single request had a 300k-token
context. The Activity screen must stop presenting it as generic “Total
Tokens.”

### Newest OpenCode run

“Add an optional Review Plan Before Implementation override” is the first
clean baseline for the current OpenCode adapter:

| Metric | Value |
|---|---:|
| Run wall time | 29.7 min |
| Iterations | 10 |
| Mean / median | 178.4 / 164.9 s |
| p90 / maximum | 271.4 / 311.8 s |
| At least 3 / 5 minutes | 4 / 1 |
| Model turns | 178 |
| Tool calls | 211 |
| `todowrite` calls | 29 |
| Uncached / cached input | 1,018,971 / 2,491,520 tokens |
| Output | 41,582 tokens |
| Measured tool execution | 13.6 s (0.8% of run wall time) |

One representative 249.1-second iteration made 22 sequential model turns. It
processed 149,744 uncached plus 444,672 cached input tokens and 5,300 output
tokens; its tools ran for about 1.6 seconds. Approximately 75% of cumulative
input was served from cache, so caching is working. Sequential inference
round-trips and repeated context processing—not tests, git, or filesystem
latency—dominate this sample.

Transcript review also found avoidable behavior:

- The model maintains a second task list with `todowrite` even though
  `.ralph/PLAN.md` is already the task list. These 29 calls account for 13.7%
  of tool calls and usually force another model turn.
- Each iteration asks the model to update the checklist, inspect/stage the
  diff, compose a commit, and report completion. This bookkeeping is repeated
  for every plan item.
- Some iterations re-read files, repeat checks, or recover from shell quoting
  mistakes. One wrote a helper under the system temporary directory despite
  the worktree-only rule.
- Current OpenCode config lists several allowed legacy `tools`, but OpenCode
  enables tools by default. Omitted tools such as `todowrite` remain available;
  the `tools` field is deprecated in favor of explicit permissions.
- Run rows retain the requested provider/model even if fallback resolves to a
  different pair, making provider comparisons unreliable.

## External findings

The optimization direction matches the underlying Ralph pattern rather than
fighting it:

- Geoffrey Huntley's Ralph guidance says the wheel's speed matters, recommends
  one coherent item per fresh-context loop, and recommends running only the
  test for the unit just changed. It does not prescribe a five-minute cutoff.
  See [Ralph Wiggum as a software engineer](https://ghuntley.com/ralph/).
- Anthropic recommends the smallest high-signal context and a minimal viable
  tool set, noting that context has diminishing returns. Its long-running
  harness guidance recommends incremental sessions with durable progress
  artifacts, which is already the purpose of PLAN.md and git history. See
  [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
  and [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).
- OpenCode documents that built-in tools are enabled by default, its `tools`
  config is deprecated, and explicit `permission` rules are the supported way
  to deny `todowrite`, external-directory access, tasks, web access, skills,
  and other unused capabilities. See [OpenCode agents](https://opencode.ai/docs/agents/)
  and [tools](https://opencode.ai/docs/tools/).
- OpenRouter defaults to price-prioritized provider selection. It supports
  explicit throughput or latency sorting, while prompt-cache stickiness and
  cached-token accounting must be measured when routing changes. See
  [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection),
  [prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching),
  and [usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting).
- Claude Code's supported `--tools` flag restricts which tools enter the
  model's context; `--strict-mcp-config` only controls MCP servers. See the
  [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage).

Sources were checked on 2026-07-13.

## Performance policy

Duration is a service-level indicator, not the objective by itself. Optimize
for accepted work per minute and per dollar.

After at least 30 iterations on the current harness/model combination:

| Signal | Target |
|---|---:|
| Median iteration duration | at most 120 s |
| p90 iteration duration | at most 240 s |
| Iterations at least 5 minutes | under 5% |
| Median model turns per iteration | at most 14 |
| Review approval / criteria pass rate | no regression from baseline |

The targets are alerts and experiment gates, not automatic failure conditions.
A soft “slow iteration” event (`iteration.slow`) fires at five minutes. A
separate configurable per-iteration hard timeout
(`iterationHardTimeoutMinutes`, default 10) is capped by the run's remaining
timeout. Two consecutive iteration timeouts move the card to Needs
Attention; a single timeout preserves the worktree and may be retried once.
The existing run timeout remains the final wall-clock cap.

Two further protections address failure modes observed in the field. A stall
watchdog (`stallTimeoutSeconds`, default 300) kills a harness invocation
that emits nothing for the window — a hung provider stream, dropped network,
or machine sleep otherwise burns the whole iteration budget in silence; the
kill signals the harness's entire process group so grandchildren cannot hold
the pipe open. And under orchestrator bookkeeping, an `ITERATION_DONE` signal
from an iteration that changed nothing (no new commit, no worktree delta
beyond the signal file) is a *phantom completion*: the orchestrator emits
`iteration.phantom`, refuses to advance the checklist, and lets normal stall
detection see the unchanged state instead of silently marking undone work
done.

Do not terminate an iteration merely for crossing the 120-second median
target. That would discard useful work and can make the whole run slower.

## Phase 0 — Make the measurements true

Optimization work must land after, or alongside, telemetry that can prove its
effect.

### Normalized events

Extend normalized transcript events without dropping the raw fallback:

```ts
type UsageEvent = {
  t: "usage";
  inputTokens: number;          // uncached input for this model turn
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  outputTokens: number;
  reasoningTokens?: number;
  costUsd?: number;
  timestampMs?: number;
};

type ToolEvent = {
  t: "tool";
  name: string;
  input: unknown;
  output?: string;
  durationMs?: number;
  timestampMs?: number;
};
```

Adapters map the fields their harness exposes and use zero only when the
harness explicitly reports zero; unavailable fields stay unavailable. Do not
add cumulative session totals and per-turn totals together. The normalization
invariant that enforces this: every `usage` event is per-model-turn. An
adapter whose harness reports only a session-cumulative total emits exactly
one usage event for the whole invocation instead of passing cumulative
snapshots through. (Claude Code's final result event is believed to carry
cumulative usage — the pinned fixture must confirm this rather than trusting
memory.) `model_turns` is then simply the count of usage events and can never
double-count. Unit tests use real pinned event fixtures for Claude Code,
OpenCode 1.17.18, and Codex.

### Persisted iteration facts

Add nullable columns in an additive migration for:

- `cached_input_tokens`, `cache_write_tokens`, `reasoning_tokens`
- `model_turns`, `tool_calls`, `tool_duration_ms`
- `first_token_ms` when the harness exposes enough timestamps
- `actual_provider`, `actual_model`, `harness`, and `harness_version`
- optional `cost_usd`

Keep the existing columns for migration compatibility, but label
`prompt_tokens` as **uncached cumulative input** in code and UI. A fallback
updates actual provider/model while retaining the originally requested pair.

### Activity screen

Add filtered loop KPIs for p50, p90, p95, maximum, five-minute outlier rate,
model turns per iteration, cache-hit ratio, tool time, and cost when known.
Breakdowns use actual provider/model/harness/version. Show sample size beside
percentiles and do not compare cohorts with fewer than 10 iterations.

The existing `iterationDurationsMs` value is currently computed but not
rendered; render it rather than creating a second duration calculation.

## Phase 1 — Remove turns that do not implement the task

### Enforce a genuinely minimal tool set

[12-pi-harness.md](12-pi-harness.md) offers a structural route to this
section's end state for the proxied providers: pi's built-in tool surface is
already exactly the Ralph set, with no todo, task, web, or skill tools to
deny. The permission work below still applies to the opencode cohort, and the
pi cohort competes under this spec's Phase 3 benchmark rules.

Replace OpenCode's deprecated positive `tools` list with agent-level
permissions. Start with a deny wildcard, then allow only read, edit/write,
glob, grep, list, and bash. Explicitly deny external-directory access,
`todowrite`, task/subagent tools, web tools, LSP, skills, questions, doom-loop
recovery, and MCP/custom tools. Keep `--pure` and `--auto`; explicit denies
still apply under auto approval.

The Claude Code loop adapter similarly passes `--tools` with only the
filesystem, search, edit, and shell tools required by Ralph, in addition to
`--strict-mcp-config`. Planner, evaluator, and summarizer tool sets are separate
because their jobs differ.

Adapter tests assert the deny-by-default contract. A live smoke test must
prove that an attempted write outside the worktree is denied and an ordinary
edit/test inside it succeeds.

### Stop asking the model to manage two plans

PROMPT.md says that PLAN.md is the only task list and explicitly forbids
creating or updating a harness todo list. It also asks the model to batch
independent reads/searches and avoid post-edit rereads unless a check fails or
the edit tool reports ambiguity.

This is expected to eliminate roughly 29 tool calls and their associated
turns in a run shaped like the newest baseline. The measured result, not that
estimate, decides whether it stays.

### Move deterministic bookkeeping into the orchestrator

The agent implements and verifies exactly one plan item, then writes
`.ralph/ITERATION_DONE` with a short summary. It does not edit PLAN.md, stage,
or commit. When and only when that signal exists, the orchestrator:

1. changes the selected PLAN.md item from unchecked to checked;
2. removes the iteration signal;
3. commits all worktree changes with a deterministic message containing the
   task number and summary;
4. checks whether another item remains.

For the last item, the agent writes `.ralph/DONE` after its targeted check
passes. It does not read or run CRITERIA.md. That whole-card checklist belongs
exclusively to the evaluator, which runs every criterion after DONE and gates
human review. The orchestrator performs the same checklist/commit mechanics.
Thus PLAN.md and git history remain the fresh context's durable memory; only
mechanical work moves out of inference.

If the agent exits successfully without `ITERATION_DONE`, dirty changes are
preserved for diagnosis but the checklist is not advanced and nothing is
auto-committed. Progress detection includes both HEAD and worktree status so
an uncommitted useful edit is not mislabeled as “no activity,” but three runs
without the signal still trigger `stalled`.

## Phase 2 — Improve task and context shape

The planner continues to produce one item per loop, but “one item” means one
coherent, independently verifiable outcome—not one file or one mechanical
edit. Production behavior and its direct tests belong in the same item when
they share the same context. Avoid separate tasks whose only purpose is
wiring, documentation, or a type update that is inseparable from the preceding
change.

There is no numeric target or cap on item count: the checklist has exactly as
many items as the definition of done demands, and a big card may legitimately
need many. Item *coherence*, not item count, is the sizing rule — and it is
guidance, not an orchestrator rejection rule. Every item names one targeted
verification command. Full criteria are evaluator backpressure after DONE,
not a final loop task.

At iteration start, the orchestrator appends the exact selected checklist item
and `LAST_TASK=true|false` to the effective prompt. The assigned block is the
agent's only task source; it does not read PLAN.md or CRITERIA.md. The checklist
parser must support multiline items and have fixture tests. It is one
standalone module (e.g. `src/server/checklist.ts`) shared by Phase 1's
orchestrator bookkeeping and this phase's task injection — the two features
must not grow separate PLAN.md parsers.

Do not summarize source files into the prompt up front. Let grep/read retrieve
only the relevant code just in time.

## Phase 3 — Benchmark models

Do not hard-code a “best” model. Models and provider endpoints change. The
repeatable benchmark corpus is implemented under `benchmarks/` (see
`benchmarks/README.md`): each fixture has a task description and a
machine-checkable `CRITERIA.md`, driven by the shared dependency-free Node
runner `benchmarks/run-benchmark.mjs`, which runs a fixture at least three
times and hard-resets the target repo to a baseline commit between runs so
results stay comparable (the pipeline is serial by design). All four
representative shapes are covered:

- `snake-tui` — a medium greenfield build, “Create snake in a Python TUI.” It
  starts from an empty repo, so it exercises planner sizing and multi-item
  checklists rather than existing-code navigation. Because the benchmark
  cannot eyeball a TUI, its criteria are machine-checkable: game logic in a
  headless-testable module with unit tests (movement, growth, collision, game
  over), the terminal rendering layer kept thin, and a smoke check that the
  program starts and exits cleanly.
- `small-ui-change` — a small UI change in an existing codebase (seeded task
  board; add a priority badge and count to pure render functions).
- `server-data-change` — a server/data change with validation edge cases
  (seeded notes API; add validated tags and tag filtering).
- `failing-test-repair` — diagnosis: the seed’s test suite fails because of
  planted production bugs; the tests are hash-pinned so they cannot be edited
  around.

Benchmarks can also be launched from the **Benchmarks** screen, which shows
the fixture corpus, report summaries from `benchmarks/reports/`, and the
rollout-acceptance targets evaluated over the most recent 30 iterations.

Run each candidate at least three times, and report:

- criteria pass and diff correctness;
- total wall time and iterations;
- model turns and p50/p90 iteration time;
- uncached, cached, output, and reasoning tokens;
- cost and review outcome.

A candidate is promoted only if it has no quality regression and improves
median accepted-work wall time by at least 20%, or offers a user-selected cost
tradeoff. The pipeline runs one ticket at a time, so benchmarks are inherently
serial — no cross-loop contention obscures per-loop latency or rate-limit
effects.

## Rollout and acceptance

Ship the phases behind independently reversible settings and annotate each run
with its experiment cohort. Suggested setting keys: `minimalToolset`,
`orchestratorBookkeeping`, and `taskInjection`; the per-iteration hard timeout
is its own numeric setting.

1. Capture at least 10 baseline iterations with corrected telemetry. The
   per-iteration hard timeout and `iteration.slow` event ship here too —
   they are protective, independent of the later phases, and at the 10-minute
   default they change behavior only for runs that are already pathological.
2. Enable the minimal tool set; run adapter tests and at least 10 live
   iterations. Keep it if quality is unchanged and median turns fall.
3. Enable orchestrator bookkeeping for one cohort; verify signal, failure,
   restart, rejection, last-task criteria, and merge paths.
4. Enable task injection/planner sizing, then collect a combined sample of at
   least 30 iterations.
5. Declare this spec's initial optimization complete when the performance
   policy targets are met without a lower criteria-pass or approval rate.

The Activity screen shows before/after cohorts so a future prompt, harness, or
model upgrade cannot silently erase the gain.

## Non-goals

- Removing targeted tests, type checks, lint, or final criteria to make charts
  look faster.
- Reusing a conversation across Ralph iterations; fresh context remains the
  core loop contract.
- OpenRouter response caching for agent turns. Tool-driven requests mutate
  state and are not safe to replay as identical responses.
- Automatically selecting the cheapest or fastest model without a quality
  benchmark and an explicit user cost preference.
