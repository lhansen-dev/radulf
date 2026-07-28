# 09 — Multi-harness loop runners

The loop runner's harness follows the provider, instead of every provider being
squeezed through `claude -p`:

| Provider | Harness | Auth |
|----------|---------|------|
| `anthropic` (default) | **Claude Code** (`claude -p`) | user's Claude subscription login, as today |
| `omlx` | **opencode** (`opencode run`) | oMLX API key (or open server) from Settings |
| `openrouter` | **opencode** (`opencode run`) | OpenRouter API key from Settings |
| `chatgpt` | **Codex CLI** (`codex exec`) | user's ChatGPT subscription login (`codex login`) |

**Why.** A full swap to opencode was considered and rejected: Anthropic locks
subscription OAuth to first-party clients, so opencode can only reach Anthropic
with a raw API key — which locked decision 3 forbids. Instead each provider
gets its native path:

- The subscription path keeps the harness that's allowed to use it (and whose
  prompt is tuned for Claude models). Zero migration, already proven.
- The proxied providers get a harness that's model-agnostic by design and
  configured explicitly, which **deletes the env-spoof machinery** in
  `src/server/providers.ts` — `ANTHROPIC_BASE_URL` redirection, the
  `ANTHROPIC_DEFAULT_*_MODEL` override stack, and the documented footgun where
  a stray `/model fable` in `~/.claude/settings.json` could leak an expensive
  real model id to OpenRouter. opencode resolves models from *our* generated
  config as an explicit `provider/model` pair; that failure class is gone.
- Per-iteration context overhead drops on the proxied path: a stripped opencode
  agent (minimal prompt, tight tool set, no MCP) instead of the full Claude
  Code harness pointed at a non-Claude model.

**Scope.** Only the **LoopRunner** is affected. PlanRunner and PMRunner are
frontier runs on the subscription (locked decision 3) and stay `claude -p`
unchanged. The board, worktree model, serial queue, `.ralph/` contract, and caps
were untouched by this harness change. The evaluator gate added later in 04
reuses the same provider/harness adapter seam and changes DONE from a direct
review transition into the trigger for evaluation.

**Amendments.** This spec amends locked decisions **4** (loop agent = "Claude
Code CLI against a configurable provider" → "the provider's harness: Claude
Code for `anthropic`, opencode for `omlx`/`openrouter`") and **7**
(`--dangerously-skip-permissions` → "the harness's skip-permissions posture";
for opencode that's `--auto`). Decision 3 is unchanged — it's the reason this
spec looks the way it does. Prose reconciliation is listed at the end.

## The adapter seam

One narrow interface, two implementations, chosen by provider. No plugin
framework — a switch and a type:

```ts
type HarnessId = "claude-code" | "opencode" | "codex";

interface RunnerSpawn {
  command: string;          // "claude" | "opencode"
  args: string[];
  env?: NodeJS.ProcessEnv;  // undefined = inherit (claude-code subscription path)
  cwd: string;              // the card's worktree
}

interface RunnerAdapter {
  harness: HarnessId;
  /** Build the spawn for one fresh-context invocation. */
  spawn(opts: { prompt: string; model: string; worktree: string; runDir: string }): RunnerSpawn;
  /** Normalize one stdout line into zero+ transcript events (see Transcripts). */
  normalize(line: string): TranscriptEvent[];
}

function adapterFor(provider: ProviderId): RunnerAdapter {
  if (provider === "anthropic") return claudeCodeAdapter;
  if (provider === "chatgpt") return codexAdapter;
  return makeOpencodeAdapter(provider);
}
```

`providerRunConfig`'s job (env dicts) is absorbed into the adapters;
`listProviderModels` and `preflightProvider` keep their current provider
switch and are harness-independent.

## claude-code adapter (`anthropic`)

Today's subscription path, verbatim: inherited env, `--model` from settings
(blank = account default), `--output-format stream-json`,
`--dangerously-skip-permissions`, cwd = worktree. Its normalizer is ~the
identity mapping onto the existing transcript shape.

One addition while we're here — trim fixed per-iteration context, since that
was half the motivation for looking beyond Claude Code in the first place:

- `--strict-mcp-config` with no MCP servers configured (MCP instruction blocks
  are the largest avoidable injected cost),
- no repo `CLAUDE.md` in the worktree beyond what the plan writes,
- keep `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.

## opencode adapter (`omlx`, `openrouter`)

Flags verified against **opencode 1.17.18**:

```
OPENCODE_CONFIG=<runDir>/opencode.json \
  opencode run "<prompt>" \
    --model <provider>/<model> \
    --agent ralph \
    --dir <worktree> \
    --format json \
    --auto \
    --pure
```

- `--format json` — raw JSON events on stdout; the analog of `stream-json`.
- `--auto` — auto-approve all permissions not explicitly denied (opencode's
  help says "dangerous!"); the skip-permissions posture. No `permission`
  deny-list in v1 — containment stays structural (worktree + prompt
  guardrails), per the classic Ralph posture.
- `--pure` — no external plugins; reproducible context.
- Fresh session by default (`--continue`/`--session` are opt-in resume flags
  we never pass) — exactly the Ralph fresh-context-per-iteration posture.

**Generated config, no global state.** The adapter writes `opencode.json` into
the **run's data dir** (not the worktree — it must not appear in the card's
diff) and points `OPENCODE_CONFIG` at it, so the user's global opencode config
never influences a run. Because opencode never talks to Anthropic here, there
is **no opencode login step at all**: the only credentials are the oMLX /
OpenRouter keys already stored in Radulf settings, injected into the config.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    // exactly one of these, matching the selected provider:
    "omlx": {
      "npm": "@ai-sdk/anthropic",        // oMLX speaks /v1/messages; if it doesn't
      "options": {                        // slot cleanly, fall back to
        "baseURL": "<settings.omlxBaseUrl>",  // @ai-sdk/openai-compatible (checklist)
        "apiKey": "<settings.omlxApiKey || \"omlx\">"
      },
      "models": { "<id from /v1/models>": {} }
    },
    "openrouter": {                       // built-in provider; key via options
      "options": { "apiKey": "<settings.openrouterApiKey>" }
    }
  },
  "agent": {
    "ralph": {
      "prompt": "You are executing one iteration of an autonomous coding loop. Follow the instructions in the user message exactly.",
      "tools": { "read": true, "write": true, "edit": true, "bash": true,
                 "grep": true, "glob": true, "list": true, "webfetch": false }
    }
  }
}
```

The `ralph` agent is the token-overhead lever: minimal system prompt (behavior
lives in `.ralph/PROMPT.md`, unchanged), filesystem+shell+search tools only,
no MCP, no plugins.

**Tool-config amendment.** The `tools` block above records the initially
shipped configuration, but omitted OpenCode tools remain enabled by default.
[11-loop-performance.md](11-loop-performance.md) supersedes it with explicit,
deny-by-default `permission` rules and the measured rollout for that change.

**Harness amendment.** [12-pi-harness.md](12-pi-harness.md) adds `pi` as a
fourth `HarnessId` and a candidate replacement for opencode on this proxied
pair, selected by the `proxiedHarness` setting (default remains opencode).
That spec narrows the "harness choice as a user-facing setting" non-goal
below to a single experiment toggle for the proxied providers only.

Blank-model rules carry over from today's `providerRunConfig`: blank is
acceptable for `omlx` (local, unmetered, server default), **OpenRouter must
fail loudly on a blank model** rather than fall back to anything.

## Transcripts

One normalized event schema, two normalizers. `transcripts/<runId>/iter-NNN.jsonl`
stays the storage; the DB status mirroring, SSE feed, and In Review viewer
consume only normalized events, so the UI (05) never learns which harness ran.

```ts
type TranscriptEvent =
  | { t: "text"; role: "assistant"; content: string }
  | { t: "tool"; name: string; input: unknown; output?: string }
  | { t: "usage"; inputTokens: number; outputTokens: number }
  | { t: "result"; exit: "completed" | "failed"; detail?: string }
  | { t: "raw"; line: string };   // fallback: never drop data
```

- claude-code: map `stream-json` lines (near-identity).
- opencode: map `--format json` events; pin the exact schema against a live
  run (checklist). `opencode export <sessionID>` is a lossless fallback and
  `opencode stats` a cross-check for usage numbers.

**Measure the thesis.** Capture `usage` per iteration on both harnesses. The
claim that a stripped opencode agent is meaningfully leaner per iteration than
trimmed `claude -p` is this spec's justification for the proxied path — record
the numbers (feeds roadmap backlog #3, metrics).

## Codex CLI adapter (shipped)

The `chatgpt` provider is the third harness, backed by the Codex CLI (`codex exec`).
It ships the adapter `codexAdapter` (`src/server/harness/codex.ts`) and the
`chatgpt` provider registration (`src/server/providers.ts`). The seam's three
lines (table above) are now fully filled: the `HarnessId` union is
`"claude-code" | "opencode" | "codex"` and `adapterFor` dispatches all three
exhaustively (no `else` catch-all in the real code — a typed `if/if/else` on the
param).

Setup requires the Codex CLI installed and `codex login` complete (same
subscription-auth model as the Claude path). No API-key setting is needed.

Model options for the `chatgpt` provider are populated dynamically from the Codex
CLI's `~/.codex/models_cache.json` (mirroring how `anthropic` lists models from
the claude CLI), replacing the former hardcoded pair of `gpt-5-codex` and
`gpt-5`.

Its normalizer (`codexAdapter.normalize`) maps the real Codex CLI (`item.completed`, `turn.completed`, `turn.failed`, `error`) JSON event schema pinned against **codex-cli 0.144.3**, so assistant text, usage, and model errors surface as normalized transcript events.

## Reconciliation (part of this work)

- `src/server/providers.ts` — delete `proxyEnv`/`scrubbedEnv` and the
  `ANTHROPIC_*` override stack; introduce the adapters (new
  `src/server/runners/` module or similar); keep `PROVIDERS`,
  `listProviderModels`, `preflightProvider` as-is.
- LoopRunner — spawn via `adapterFor(provider)`; PlanRunner/PMRunner untouched.
- Transcript pipeline — introduce `TranscriptEvent` normalization; adapt the
  viewer/SSE to consume it (claude-code mapping first, proving no UI churn).
- Docs — 00 (decisions 4/7 amendment note, index row, intro, glossary), 02
  (Runner contracts + LoopRunner env paragraph → adapters; architecture
  diagram's LoopRunner line; safety posture), 04 (intro I/O line, loop
  pseudocode, skip-permissions detail, oMLX verification note), 07 (walkthrough
  steps 2/4; risk rows "Claude Code CLI flag drift" → "harness flag drift ×2"
  and oMLX env contract → API surface; deferred bets += Codex CLI), 08 (the
  "spawns `claude -p`" line), README (add opencode ≥1.17 as a prerequisite when
  using oMLX/OpenRouter; note it's *not* needed for the default subscription
  path and needs no login). **Done alongside this spec.**
- Settings/schema — none required; provider ids, per-role provider/model, and
  credential fields are reused. Harness is derived from provider, not stored.

## Non-goals

- opencode for the `anthropic` provider — impossible on subscription auth
  (OAuth is first-party-only) and forbidden with API keys (decision 3).
- Codex CLI / ChatGPT — shipped as the third harness (above).
- New providers (OpenAI API, Gemini, Ollama, …) — the seam permits them later;
  this spec preserves exactly today's three.
- Harness choice as a user-facing setting — it's a function of provider.
- Interactive/TUI use of either harness — headless only.

## Verification checklist

Settled against opencode 1.17.18's CLI surface: `run` flags (`-m/--model`,
`--agent`, `--dir`, `--format json`, `--auto`, `--pure`), fresh-session
default, `models [provider]`, `export`, `stats`.

To pin against live runs before the code lands:

1. `OPENCODE_CONFIG` fully overrides the user's global config (isolation).
2. `--auto` executes `bash` headlessly with no stall-on-gate (a silent gate
   would hang a loop until the wall-clock timeout).
3. oMLX provider block: `@ai-sdk/anthropic` vs `@ai-sdk/openai-compatible`
   against a live oMLX; whether a custom provider requires the explicit
   `models` map.
4. OpenRouter: key via `provider.openrouter.options.apiKey` in the generated
   config suffices (no `opencode providers login` needed); a tool-using run
   completes with `--model openrouter/<id>`.
5. The `--format json` event schema, for the normalizer and usage capture.
6. Trimmed `claude -p` baseline: `--strict-mcp-config` works in the LoopRunner
   spawn and measurably cuts fixed input tokens.

## Risks

| Risk | Mitigation |
|------|-----------|
| Two harnesses to track instead of one (flag/format drift) | Pin versions in README; adapters isolate drift to one file each; rerun the checklist after upgrades |
| opencode's JSON event schema shifts | Normalizer owns the mapping; `t:"raw"` fallback never loses transcript data; `export` as recovery |
| Stripped opencode agent not actually leaner than trimmed `claude -p` | Per-iteration usage capture on both paths; if the numbers don't hold, the proxied path can still be justified on the env-spoof deletion alone — but record it |
| `--auto` gate stall hangs a loop | Checklist #2 smoke test + existing wall-clock timeout backstop |
| oMLX doesn't fit `@ai-sdk/anthropic` | Fall back to `@ai-sdk/openai-compatible` on its OpenAI-shaped route |
| Transcript normalization churns the In Review viewer | claude-code near-identity mapping ships first to prove the contract, then opencode joins it |
