# Providers and models

Every agent role runs through the same harness —
[pi](https://github.com/earendil-works/pi) in SDK mode, in-process. There is no
subprocess and no CLI to install. Your provider choice decides only **how the
request is authenticated**, which is why you can mix providers freely across
roles.

## The five providers

| Provider | Auth | Where it runs | Notes |
|----------|------|---------------|-------|
| **Anthropic / Claude** | Settings, or `make login` | Remote | The default. Uses your Claude Pro/Max subscription. Third-party harness usage is billed per token as extra usage. |
| **ChatGPT (Codex)** | Settings, or `make login` | Remote | Uses your ChatGPT Plus/Pro subscription. |
| **GitHub Copilot** | Settings, or `make login` | Remote | Uses your GitHub Copilot subscription. |
| **OpenRouter** | API key | Remote | Bring your own model. Set the key in Settings — no login. |
| **Local / self-hosted** | Base URL | Wherever you run it | Any OpenAI-compatible server: oMLX, vLLM, LM Studio. Optional and unmetered. Set the base URL in Settings, no login. |

### From the app

**Settings → Providers & keys** lists every provider that can be logged in to,
says which are connected, and runs the login itself (spec 23). Pick **Sign in**
and Radulf drives pi's own login flow, showing you what it asks for:

- A link to open, for Anthropic and Codex. Authorize in whatever browser you
  like, then paste back either the authorization code or the whole URL your
  browser was redirected to. That page will have failed to load if the browser
  is not on the machine running Radulf, which is expected and does not matter.
- A device code and a URL, for GitHub Copilot. Enter the code there; nothing
  to paste back.
- A masked field, for a provider you would rather give an API key.

**Disconnect** forgets the credential. Radulf never reads or stores a token
itself: pi owns `auth.json`, including refreshing it, and all that crosses the
app is your answers.

### From a terminal

Still supported, and the only way with no browser to hand. One interactive
step, run once, pointed at Radulf's own agent directory (`data/pi-agent/`):

```bash
make login
```

This opens pi; **`/login`** is then typed inside pi's UI, not in your shell. Pick
the provider, complete the OAuth flow, and quit with `Ctrl+C`. The credential
lands in `data/pi-agent/auth.json`.

The target exists because the agent directory has to match. pi writes its
`auth.json` wherever `PI_CODING_AGENT_DIR` points, defaulting to `~/.pi/agent/`;
Radulf only ever reads `data/pi-agent/`. Running `pi` from your own shell
authenticates the wrong directory, and the app goes on reporting that no models
are available for the provider.

## Configuring a role

Open **Settings → Agents & models** in the app. Each of the five roles —
scoping, planner, plan critic, loop, and evaluator — gets its own three pickers:

- **Provider** — one of the five above.
- **Model** — a model id. Leaving it blank means "the subscription's default
  model" for the subscription providers. OpenRouter needs an explicit model.
- **Reasoning level** — pi's thinking level, defaulting to **medium**. Because
  everything runs through one harness this applies across every provider; pi
  clamps a level a given model does not support to the nearest one it honors.

Use **Browse available models** to expand a short model list, or type in the
model field to search. **Load models** saves your settings and refreshes the
provider's list. Configure API keys and the local server under
**Providers & keys**, and time and iteration budgets under **Run limits**.
Edits stay with you as you switch sections; **Save settings** at the top applies
them together.

Cards can also carry per-card model overrides, which is what lets you pause a
struggling loop, raise its model, and continue.

## Choosing sensibly

The roles have genuinely different demands, and matching them is where the cost
savings live.

**Scoping is the one role you wait on.** It runs a turn at a time while you sit
in the conversation, reading the repository to ask a useful question rather
than a generic one. A slow or shallow model here costs your attention directly,
and a session is a handful of turns per card, so it is a cheap place for a
strong model.

**The planner benefits most from a frontier model.** It reads a repo it has
never seen and decides what the work actually is; a weak plan poisons every
iteration downstream. This is the last role to economize on.

**The loop runs many times over, so the difference between models compounds
here more than anywhere else.** It is also the most forgiving of a cheaper
model, because the evaluator catches what it gets wrong and the plan
constrains what it has to figure out for itself. Whether the loop is
actually *where your tokens go* — as opposed to the planner or evaluator — is
no longer just an assumption to take on faith, but it also isn't yet verified
against real numbers: the roll-up under ["What a card
costs"](#what-a-card-costs) below now measures per-role cost, but the only
figures on record predate that change and are loop-only. Re-run the benchmark
before treating this as settled.

**The evaluator should not be the same agent that wrote the code** — not for
cost reasons but for independence. Its whole value is looking at the diff
without having decided in advance that the diff is correct.

Settings states each of these demands next to the role it applies to, and flags
a provider that does not suit its role: a planner or evaluator on a self-hosted
endpoint, and equally a loop on a subscription, which is the same mistake
pointed the other way. A summary above the four sections offers the split in
one click when any role is off it, and stays out of the way when none is. The
advisories never block saving, so a deliberate choice (benchmarking a local
planner, say) is one dropdown away.

The local provider speaks the OpenAI wire format: Radulf lists what you are
serving from `/v1/models` and runs the loop against `/v1/chat/completions`. The
base URL is the server root (`http://127.0.0.1:8000`, the default), though a URL
that already ends in `/v1` is accepted too.

Most local servers need no credential, so the **Local server API key** can stay
blank; when set, it is sent as a bearer token. A gateway in front of the server
that authenticates on a header of its own, such as Kong's `kong-api-key`, takes
**Extra request headers**: one `Name: value` per line, sent with every request
alongside the key. A header named `Authorization` replaces the key's bearer
token rather than being sent next to it.

Two things must hold before you start a loop: the server has to be running and
reachable at that base URL, and the model has to be tool-capable. On vLLM that
means starting it with `--enable-auto-tool-choice` and the `--tool-call-parser`
its model family needs. Radulf reads the served context window from
`max_model_len` when the server reports one, so pi compacts against the real
budget rather than an assumed one. A server that reports none (oMLX, LM Studio,
or a gateway that strips the field) falls back to a conservative 32,768 tokens,
which compacts far too early for a large model; state the real number under
**Context windows**, one `model-id: tokens` per line. An entry there wins over
the served value, and the model picker shows whichever applies.

## What a card costs

Measured, not estimated — but read the scope before you use these numbers.

Three runs of the `small-ui-change` benchmark fixture (a small change to an
existing codebase), loop on OpenRouter `deepseek/deepseek-v4-flash`, planner on
`z-ai/glm-5.2`, reasoning level high, on 2026-07-30:

| | Median | Range |
|---|---|---|
| **Loop cost** | **$0.0033** | $0.0024 – $0.0057 |
| Loop iterations | 1 | 1 – 2 |
| Model turns | 7 | 7 – 17 |
| Prompt tokens | 16,122 | 8,101 – 22,598 |
| Cached input tokens | 23,552 | 15,872 – 51,200 |
| Completion tokens | 2,180 | 2,124 – 3,839 |
| Reasoning tokens | 352 | 298 – 698 |
| Wall time, whole card | 2m 15s | 1m 58s – 4m 42s |

All three runs passed every acceptance criterion and produced a correct diff.

> **This table is the loop's cost, not the card's, and is pending a re-run.**
> Radulf now records a token/cost roll-up on every run — planner and evaluator
> included, not just the loop's iterations — and `run-benchmark.mjs`'s
> `costByKind` reports the true per-role split (see `benchmarks/README.md`).
> The numbers above predate that change and were measured back when planner
> and evaluator spend was invisible, so they understate what the card actually
> cost. Since the guidance above is to put a frontier model on the planner,
> the missing part is plausibly the larger one — reproduce the benchmark run
> to find out, and replace this table with the per-role figures it reports.

Two more caveats worth stating plainly. This is one fixture at n=3 on one
provider, so it establishes an order of magnitude and nothing more — the spread
above is already 2.4× between the cheapest and dearest run, driven by whether
the loop finished in one iteration or two.

And a smooth card is the cheap case. An evaluator `revise` sends the card back
through the loop, so each one buys another full loop pass plus another
evaluator pass; a separate observed run of this same fixture took two revisions
and ran seven runs end to end rather than three. The table above is three runs
that all passed first time.

Reproduce or extend it with `benchmarks/run-benchmark.mjs` — see
[`benchmarks/README.md`](../benchmarks/README.md).

## Watching your allowance

**Providers & keys** carries a usage and health panel: what Radulf has spent
through each provider over the last 24 hours, its current allowance, and
whether any provider is refusing work right now.

The allowance figures come from the response headers of the agent's own
requests. There is no quota endpoint to poll, but the providers stamp every
response with where the account stands, so Radulf reads that off traffic it was
making anyway. It is scoped to the credential Radulf itself uses, not to
whatever is logged in elsewhere on the machine.

What you see depends on what the provider sends. A Claude subscription reports
utilization for both its 5-hour and 7-day windows, which one is currently
binding, when each resets, and whether the plan has paid overflow past the
limit. An OpenAI-compatible endpoint reports request and token counts. A
self-hosted server usually reports nothing, and the panel then shows nothing
for it rather than implying it is healthy.

Cost is shown only for providers that meter it. A flat-rate subscription reads
as having no meter rather than as having spent $0.00.

### When a provider runs out

An exhausted allowance is treated as its own kind of failure, separate from a
provider being unreachable. It opens that provider's circuit breaker on the
first occurrence rather than after three: the allowance is gone, and spending
two more runs proving it only burns the card's failure budget.

How long Radulf then holds off depends on what it knows, in order of
preference: the reset instant from the provider's own headers, then any
retry-after stated in the error, then a per-provider default. A subscription
window is measured in hours, so its default is an hour rather than the minute
that suits a dropped connection.

Transient capacity errors are deliberately not treated this way. Anthropic's
529 "overloaded" clears in seconds, and holding a provider off for an hour over
one would be far too pessimistic.

## Optional: web search

Setting a **Brave Search API key** in Settings gives the **planner** a
`web_search` tool. Without a key the tool is still registered but fails loudly
when invoked, rather than silently pretending to search.

The loop and the evaluator never get it, whether or not a key is set. That is a
containment rule, not an oversight: those two roles hold `bash`, and a role with
both command execution and network reach holds each half of an exfiltration
chain. See [Sandboxing](SANDBOXING.md#role-capability-split).

## Testing without a model: the mock provider

For development there is a sixth, hidden provider: **`mock`**, a scripted
stand-in that calls no model and costs nothing. Only the model's decisions are
canned. pi still runs every tool call for real, so the worktree, file tools,
sandboxed bash, signal files, commits, transcripts, telemetry, and the board
all behave as they would on a real run, in seconds.

It is off unless the server runs with `RADULF_MOCK_LLM=1` (in `.env.local`, or
the environment of `make dev`). It doesn't appear in the Settings dropdown
unless a role already uses it, so select it through the API:

```bash
curl -X PATCH http://localhost:3000/api/settings -H 'content-type: application/json' \
  -d '{"plannerProvider":"mock","loopProvider":"mock","evaluatorProvider":"mock","criticProvider":"mock",
       "plannerModel":"","loopModel":"","evaluatorModel":"","criticModel":""}'
```

The model id picks a **scenario**, so a card's per-role models can steer one
card down a failure path while the rest run the happy path:

| Scenario | What happens |
|----------|--------------|
| `happy-path` (blank) | Two-task plan, both tasks done, evaluator approves |
| `revise-once` | Evaluator asks for a revision once, then approves the re-planned work |
| `critic-revise-once` | Plan critic sends the first plan back once, then approves the re-plan (needs the critic on for the card) |
| `planner-questions` | Planner raises follow-up questions; the card needs attention |
| `provider-error` | Every request fails with a provider error |
| `stuck` | Loop repeats one tool call until the stuck detector kills it |
| `phantom` | Loop claims `ITERATION_DONE` without changing anything, until the stall limit |
| `stall` | The stream never produces output, until the stall watchdog fires (≥ 30 s) |

A server without the flag refuses to run a stored `mock` provider, with an
error saying so. It never falls back to a paid provider. The scenarios live in
`src/server/harness/mock.ts`, and `src/server/mockPipeline.test.ts` drives each
one through the real orchestrator as part of `make check`.

What the mock can't tell you is whether a real model follows the prompts, or
how a real provider behaves: login, catalogs, and streaming quirks. Those
still need an occasional real run.

## Where credentials live

Provider credentials — the local server's base URL, key and extra headers, the OpenRouter key,
the Brave key — are stored in Radulf's SQLite database and flow into the agent session at
runtime. The Jira API token is stored the same way but used only host-side, when you
import an issue into a card; it never reaches an agent session. They never touch disk inside the worktree, and the agent's shell runs
with a scrubbed environment so it cannot read Radulf's own secrets.

Subscription credentials are held by pi in `data/pi-agent/auth.json`, not by
Radulf. `data/` is gitignored, and the run sandbox denies it wholesale, so an
agent cannot read the credentials it is running on.
