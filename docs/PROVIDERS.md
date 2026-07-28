# Providers and models

Every agent role runs through the same harness —
[pi](https://github.com/earendil-works/pi) in SDK mode, in-process. There is no
subprocess and no CLI to install. Your provider choice decides only **how the
request is authenticated**, which is why you can mix providers freely across
roles.

## The five providers

| Provider | Auth | Where it runs | Notes |
|----------|------|---------------|-------|
| **Anthropic / Claude** | `make login` | Remote | The default. Uses your Claude Pro/Max subscription. Third-party harness usage is billed per token as extra usage. |
| **ChatGPT (Codex)** | `make login` | Remote | Uses your ChatGPT Plus/Pro subscription. |
| **GitHub Copilot** | `make login` | Remote | Uses your GitHub Copilot subscription. |
| **OpenRouter** | API key | Remote | Bring your own model. Set the key in Settings — no login. |
| **oMLX** | Base URL | Local, Apple Silicon | Optional and unmetered. Set the base URL in Settings — no login. |

The three subscription providers share one interactive setup step, run once and
pointed at Radulf's own agent directory (`data/pi-agent/`):

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

Open **Settings** in the app. Each of the three roles — planner, loop, and
evaluator — gets its own three pickers:

- **Provider** — one of the five above.
- **Model** — a model id. Leaving it blank means "the subscription's default
  model" for the subscription providers. OpenRouter needs an explicit model.
- **Reasoning level** — pi's thinking level, defaulting to **medium**. Because
  everything runs through one harness this applies across every provider; pi
  clamps a level a given model does not support to the nearest one it honors.

Cards can also carry per-card model overrides, which is what lets you pause a
struggling loop, raise its model, and continue.

## Choosing sensibly

The roles have genuinely different demands, and matching them is where the cost
savings live.

**The planner benefits most from a frontier model.** It reads a repo it has
never seen and decides what the work actually is; a weak plan poisons every
iteration downstream. This is the last role to economize on.

**The loop is where your tokens go.** It runs many times over, so the difference
between models compounds here more than anywhere else. It is also the most
forgiving of a cheaper model, because the evaluator catches what it gets wrong
and the plan constrains what it has to figure out for itself.

**The evaluator should not be the same agent that wrote the code** — not for
cost reasons but for independence. Its whole value is looking at the diff
without having decided in advance that the diff is correct.

If you are running oMLX locally, note that the model must be tool-capable and
the server must already be running and reachable at the configured base URL
before you start a loop. The default is `http://127.0.0.1:8000`.

## Optional: web search

Setting a **Brave Search API key** in Settings gives the **planner** a
`web_search` tool. Without a key the tool is still registered but fails loudly
when invoked, rather than silently pretending to search.

The loop and the evaluator never get it, whether or not a key is set. That is a
containment rule, not an oversight: those two roles hold `bash`, and a role with
both command execution and network reach holds each half of an exfiltration
chain. See [Sandboxing](SANDBOXING.md#role-capability-split).

## Where credentials live

Provider credentials — the oMLX base URL and key, the OpenRouter key, the Brave
key — are stored in Radulf's SQLite database and flow into the agent session at
runtime. They never touch disk inside the worktree, and the agent's shell runs
with a scrubbed environment so it cannot read Radulf's own secrets.

Subscription credentials are held by pi in `data/pi-agent/auth.json`, not by
Radulf. `data/` is gitignored, and the run sandbox denies it wholesale, so an
agent cannot read the credentials it is running on.
